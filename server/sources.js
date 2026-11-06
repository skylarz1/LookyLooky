'use strict';
/**
 * Camera sources: how to hand each kind of URL to FFmpeg, and how to explain
 * its failures to a person.
 *
 *   rtsp://  the normal case — IP cameras, NVRs, UniFi Protect (rtsp://host:7447/…)
 *   http://  cameras that serve a live MP4/MJPEG over HTTP.  Includes the old
 *            camera-proxy's session-cookie login (Cortex / Hikvision-style
 *            "POST /login then send the cookie"), ported here so those cameras
 *            get every LookyLooky feature rather than a bare byte proxy.
 *   rtmp://  passed straight through
 *   test:    a built-in test pattern with a tone — `test:` or `test:1920x1080@30`
 *   anything else is treated as a file path and looped in real time
 */

const http = require('http');
const https = require('https');
const { sourceType } = require('./config');

/* --- Session login (from camera-proxy.js) -------------------------------- */

const sessionCache = new Map(); // key -> { cookie, expires }

function httpRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const transport = options.protocol === 'https:' ? https : http;
    const req = transport.request({ ...options, rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', (c) => { if (data.length < 65536) data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Login request timed out')));
    if (body) req.write(body);
    req.end();
  });
}

function extractSessionCookie(headers) {
  const sc = headers['set-cookie'];
  if (!sc) return null;
  const cookies = (Array.isArray(sc) ? sc : [sc]).map((c) => c.split(';')[0].trim()).filter(Boolean);
  return cookies.length ? cookies.join('; ') : null;
}

function extractJsonToken(body) {
  try {
    const j = JSON.parse(body);
    return j.token ?? j.session ?? j.sessionId ?? j.sid ?? j.data?.token ?? null;
  } catch { return null; }
}

/** Try the common login shapes in turn; returns a Cookie header value or null. */
async function login(key, url, username, password, log = () => {}) {
  const base = new URL(url);
  const common = {
    hostname: base.hostname, port: base.port || (base.protocol === 'https:' ? 443 : 80),
    protocol: base.protocol, headers: { 'User-Agent': 'lookylooky/1.0' },
  };
  const u = encodeURIComponent(username), p = encodeURIComponent(password);
  const attempts = [
    () => { const b = `username=${u}&password=${p}`; return httpRequest({ ...common, method: 'POST', path: '/login', headers: { ...common.headers, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(b) } }, b); },
    () => { const b = JSON.stringify({ username, password }); return httpRequest({ ...common, method: 'POST', path: '/login', headers: { ...common.headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } }, b); },
    () => httpRequest({ ...common, method: 'GET', path: `/login?username=${u}&password=${p}` }),
    () => httpRequest({ ...common, method: 'GET', path: `/login?user=${u}&password=${p}` }),
    () => httpRequest({ ...common, method: 'GET', path: `/cgi-bin/login.cgi?username=${u}&password=${p}` }),
  ];
  for (let i = 0; i < attempts.length; i++) {
    try {
      const res = await attempts[i]();
      const cookie = extractSessionCookie(res.headers);
      if (cookie && !res.body.includes('error_code')) { log(`login ok via attempt ${i + 1}`); return cookie; }
      const token = extractJsonToken(res.body);
      if (token) { log(`login ok via attempt ${i + 1} (token)`); return `token=${token}`; }
    } catch (e) { log(`login attempt ${i + 1}: ${e.message}`); }
  }
  log('all login attempts failed');
  return null;
}

async function getSession(key, url, auth, log) {
  const c = sessionCache.get(key);
  if (c && Date.now() < c.expires) return c.cookie;
  const cookie = await login(key, url, auth.username, auth.password || '', log);
  if (cookie) sessionCache.set(key, { cookie, expires: Date.now() + 55 * 60 * 1000 });
  return cookie;
}

const clearSession = (key) => sessionCache.delete(key);
const clearAllSessions = () => sessionCache.clear();

/* --- URLs ---------------------------------------------------------------- */

function buildUrl(source) {
  if (!source.params || sourceType(source.url) !== 'http') return source.url;
  const u = new URL(source.url);
  for (const [k, v] of Object.entries(source.params)) u.searchParams.set(k, String(v));
  return u.toString();
}

/** The URL with any password masked, for logs and the UI. */
function redact(url) {
  return String(url || '').replace(/(\/\/[^:/@]+:)[^@/]*@/, '$1***@');
}

function hostOf(url) {
  try { return new URL(String(url).replace(/^rtsps?:\/\//i, 'http://').replace(/^rtmp:\/\//i, 'http://')).hostname || null; }
  catch { return null; }
}

/** Basic-auth header for HTTP sources that carry auth separately from the URL. */
function basicHeader(auth) {
  return 'Basic ' + Buffer.from(`${auth.username}:${auth.password || ''}`).toString('base64');
}

/**
 * FFmpeg input arguments for a source.
 * @param {object} source normalised source
 * @param {object} settings full settings
 * @param {object} opts { key, lowLatency=true, log }
 */
async function inputArgs(source, settings, { key = '', lowLatency = true, slowProbe = false, forceTcp = false, log } = {}) {
  const type = source.type || sourceType(source.url);
  // NOT +nobuffer: it discards the packets read while probing, and the first
  // of those is the keyframe — every start would then wait a whole extra GOP
  // (1–4 s on most cameras).  The probe burst that buffering causes instead is
  // absorbed by the client, which re-anchors onto the live edge.
  // Probing is kept short; slowProbe is the retry for cameras whose stream
  // parameters only show up at a keyframe that comes later than that.
  const lat = lowLatency
    ? ['-fflags', '+genpts+discardcorrupt', '-flags', 'low_delay',
      '-probesize', slowProbe ? '5000000' : '500000', '-analyzeduration', slowProbe ? '5000000' : '500000']
    : ['-fflags', '+genpts+discardcorrupt'];

  if (type === 'test') {
    const m = /(\d+)x(\d+)(?:@(\d+))?/.exec(source.url) || [];
    const w = m[1] || 1280, h = m[2] || 720, r = m[3] || 25;
    return {
      args: ['-re', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${r}`,
        '-re', '-f', 'lavfi', '-i', `sine=frequency=${(/tone=(\d+)/.exec(source.url) || [])[1] || 440}:sample_rate=48000:beep_factor=4`],
      video: '0:v:0', audio: '1:a:0', needsEncode: true,
    };
  }
  if (type === 'rtsp') {
    const transport = forceTcp ? 'tcp' : (source.transport || settings.ffmpeg.rtspTransport || 'tcp');
    return {
      args: ['-rtsp_transport', transport, '-timeout', '10000000', ...lat, '-i', source.url],
      video: '0:v:0', audio: '0:a:0',
    };
  }
  if (type === 'http') {
    const url = buildUrl(source);
    const headers = ['User-Agent: lookylooky/1.0'];
    if (source.auth && source.auth.username) {
      if (source.auth.authType === 'basic') headers.push('Authorization: ' + basicHeader(source.auth));
      else if (source.auth.authType === 'session') {
        const cookie = await getSession(key, url, source.auth, log);
        if (!cookie) throw Object.assign(new Error('The camera rejected the username or password (session login failed)'), { auth: true });
        headers.push('Cookie: ' + cookie);
      } else headers.push('Authorization: ' + basicHeader(source.auth));
    }
    return {
      args: ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-rw_timeout', '10000000',
        '-headers', headers.join('\r\n') + '\r\n', ...lat, '-i', url],
      video: '0:v:0', audio: '0:a:0',
    };
  }
  if (type === 'rtmp') return { args: [...lat, '-i', source.url], video: '0:v:0', audio: '0:a:0' };
  // A file: loop it at real-time speed, which makes it behave like a camera.
  return { args: ['-re', '-stream_loop', '-1', '-i', source.url.replace(/^file:\/\//, '')], video: '0:v:0', audio: '0:a:0' };
}

/* --- Errors -------------------------------------------------------------- */

/**
 * Turn FFmpeg / ffprobe stderr into the one sentence an operator needs.
 * Returns null when nothing recognisable is in there.
 */
function friendlyError(stderr) {
  const s = String(stderr || '');
  const rules = [
    [/401 Unauthorized|403 Forbidden|authorization failed|Unauthorized/i, 'The camera rejected the username or password'],
    [/404 Not Found|Server returned 404|method DESCRIBE failed: 404/i, 'The camera has no stream at that path (404)'],
    [/Connection refused/i, 'The camera refused the connection — wrong port, or RTSP is switched off on it'],
    [/No route to host|Network is unreachable|Host is unreachable/i, 'The camera cannot be reached on the network'],
    [/timed out|Operation timed out|Connection timed out/i, 'The camera did not answer in time'],
    [/Name or service not known|Temporary failure in name resolution|Failed to resolve/i, 'The camera’s host name could not be resolved'],
    [/453 Not Enough Bandwidth|Not Enough Bandwidth/i, 'The camera refused another stream (too many connections open to it)'],
    [/503 Service Unavailable/i, 'The camera is busy (503) — it may have too many viewers already'],
    [/Invalid data found when processing input/i, 'The camera sent data FFmpeg could not read'],
    [/does not contain any stream|Output file .* does not contain any stream|matches no streams/i, 'The stream has no video'],
    [/Protocol not found|Unsupported protocol/i, 'That kind of URL is not supported'],
    [/No such file or directory/i, 'No such file'],
    [/spawn .*ENOENT/i, 'FFmpeg is not installed or not on the configured path'],
  ];
  for (const [re, msg] of rules) if (re.test(s)) return msg;
  return null;
}

module.exports = {
  inputArgs, buildUrl, redact, hostOf, friendlyError, login, getSession, clearSession, clearAllSessions,
  httpRequest, basicHeader,
};
