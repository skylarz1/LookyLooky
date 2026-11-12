'use strict';
/**
 * ONVIF stream discovery: ask a camera for its media profiles and their RTSP
 * addresses, so nobody has to guess "/stream1" for a camera they have never
 * seen the manual of.
 *
 * Profile S over SOAP 1.2: GetSystemDateAndTime (unauthenticated, to learn the
 * camera's clock — WS-Security digests carry a timestamp and many cameras
 * reject one more than a few seconds off), GetCapabilities for the media
 * service address, GetProfiles, then GetStreamUri per profile.  Authentication
 * is WS-UsernameToken digest, falling back to HTTP Digest for the cameras
 * that insist on it.
 *
 * Multicast: each profile's VideoEncoderConfiguration carries the camera's
 * multicast group (address, port, TTL, AutoStart), and GetStreamUri with
 * Stream "RTP-Multicast" gives the RTSP address to ask for it (on many
 * cameras the same as the unicast one; the RTSP SETUP then requests
 * multicast).  Both are reported per stream as `multicast`.
 */

const http = require('http');
const crypto = require('crypto');

const NS_DEVICE = 'http://www.onvif.org/ver10/device/wsdl';
const NS_MEDIA = 'http://www.onvif.org/ver10/media/wsdl';
const NS_SCHEMA = 'http://www.onvif.org/ver10/schema';

function tagAll(xml, name) {
  const re = new RegExp(`<(?:[\\w-]+:)?${name}\\b([^>]*)>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push({ attrs: m[1], body: m[2] });
  return out;
}
const tag = (xml, name) => { const t = tagAll(xml, name)[0]; return t ? t.body.trim() : null; };
const attr = (attrs, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs || ''); return m ? m[1] : null; };
const unescape = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

function wsSecurity(user, pass, offsetMs) {
  if (!user) return '';
  const nonce = crypto.randomBytes(16);
  const created = new Date(Date.now() + offsetMs).toISOString().replace(/\.\d+Z$/, 'Z');
  const digest = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(pass || '')])).digest('base64');
  return `<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">`
    + `<UsernameToken><Username>${escapeXml(user)}</Username>`
    + `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>`
    + `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce>`
    + `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>`
    + `</UsernameToken></Security></s:Header>`;
}
const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function post(url, body, headers = {}, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { if (data.length < 2e6) data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('The camera did not answer in time')));
    req.end(body);
  });
}

function digestHeader(www, method, uri, user, pass) {
  const p = {};
  for (const m of www.matchAll(/(\w+)="?([^",]*)"?/g)) p[m[1]] = m[2];
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  const ha1 = md5(`${user}:${p.realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';
  const resp = p.qop ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:auth:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
  return `Digest username="${user}", realm="${p.realm}", nonce="${p.nonce}", uri="${uri}", response="${resp}"`
    + (p.qop ? `, qop=auth, nc=${nc}, cnonce="${cnonce}"` : '') + (p.opaque ? `, opaque="${p.opaque}"` : '');
}

class OnvifClient {
  constructor({ host, port = 80, user = '', pass = '' }) {
    this.host = host; this.port = port || 80; this.user = user; this.pass = pass;
    this.offsetMs = 0;
    this.deviceUrl = `http://${host}:${this.port}/onvif/device_service`;
    this.mediaUrl = null;
  }

  async call(url, body, { auth = true } = {}) {
    const envelope = `<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">`
      + (auth ? wsSecurity(this.user, this.pass, this.offsetMs) : '')
      + `<s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">${body}</s:Body></s:Envelope>`;
    let res = await post(url, envelope);
    if (res.status === 401 && /digest/i.test(res.headers['www-authenticate'] || '') && this.user) {
      const u = new URL(url);
      res = await post(url, envelope, { Authorization: digestHeader(res.headers['www-authenticate'], 'POST', u.pathname, this.user, this.pass) });
    }
    const fault = /<(?:[\w-]+:)?Fault\b/.test(res.body);
    if (res.status === 401 || /NotAuthorized|not authorized|Sender not Authorized/i.test(res.body)) {
      throw Object.assign(new Error('The camera rejected the username or password'), { auth: true });
    }
    if (res.status >= 400 || fault) {
      const reason = tag(res.body, 'Text') || tag(res.body, 'Reason') || `HTTP ${res.status}`;
      throw new Error(`ONVIF error: ${unescape(reason).replace(/<[^>]+>/g, '').trim()}`);
    }
    return res.body;
  }

  async syncClock() {
    try {
      const xml = await this.call(this.deviceUrl, `<GetSystemDateAndTime xmlns="${NS_DEVICE}"/>`, { auth: false });
      const utc = tagAll(xml, 'UTCDateTime')[0];
      if (!utc) return;
      const n = (k) => Number(tag(utc.body, k));
      const t = Date.UTC(n('Year'), n('Month') - 1, n('Day'), n('Hour'), n('Minute'), n('Second'));
      if (!isNaN(t)) this.offsetMs = t - Date.now();
    } catch { /* not fatal — try with our own clock */ }
  }

  async findMedia() {
    try {
      const xml = await this.call(this.deviceUrl, `<GetCapabilities xmlns="${NS_DEVICE}"><Category>Media</Category></GetCapabilities>`);
      const media = tagAll(xml, 'Media')[0];
      const x = media && tag(media.body, 'XAddr');
      if (x) {
        // Cameras behind NAT or with a stale config advertise an address we
        // cannot reach — keep their path but use the host we were given.
        const u = new URL(unescape(x));
        this.mediaUrl = `http://${this.host}:${u.port || this.port}${u.pathname}`;
        return;
      }
    } catch (err) {
      if (err.auth) throw err;
    }
    this.mediaUrl = `http://${this.host}:${this.port}/onvif/media_service`;
  }

  async profiles() {
    const xml = await this.call(this.mediaUrl, `<GetProfiles xmlns="${NS_MEDIA}"/>`);
    return tagAll(xml, 'Profiles').map((p) => {
      const enc = tagAll(p.body, 'VideoEncoderConfiguration')[0];
      const res = enc && tagAll(enc.body, 'Resolution')[0];
      const mc = enc && tagAll(enc.body, 'Multicast')[0];
      const group = mc && (tag(mc.body, 'IPv4Address') || tag(mc.body, 'IPv6Address'));
      return {
        group: group && !/^(0\.0\.0\.0|::)$/.test(group) ? {
          address: group,
          port: Number(tag(mc.body, 'Port')) || null,
          ttl: Number(tag(mc.body, 'TTL')) || null,
          autoStart: /^true$/i.test(tag(mc.body, 'AutoStart') || ''),
        } : null,
        token: attr(p.attrs, 'token'),
        profileName: unescape(tag(p.body, 'Name') || attr(p.attrs, 'token') || 'Profile'),
        encoding: enc ? (tag(enc.body, 'Encoding') || '').toLowerCase() : null,
        width: res ? Number(tag(res.body, 'Width')) || null : null,
        height: res ? Number(tag(res.body, 'Height')) || null : null,
      };
    }).filter((p) => p.token);
  }

  async streamUri(token, stream = 'RTP-Unicast', protocol = 'RTSP') {
    const xml = await this.call(this.mediaUrl,
      `<GetStreamUri xmlns="${NS_MEDIA}"><StreamSetup><Stream xmlns="${NS_SCHEMA}">${stream}</Stream>`
      + `<Transport xmlns="${NS_SCHEMA}"><Protocol>${protocol}</Protocol></Transport></StreamSetup>`
      + `<ProfileToken>${escapeXml(token)}</ProfileToken></GetStreamUri>`);
    return unescape(tag(xml, 'Uri') || '');
  }

  /** Ask the encoder for a keyframe now.  The camera sends one on every
   *  stream of the profile, multicast included, without touching its settings. */
  async syncPoint(token) {
    await this.call(this.mediaUrl,
      `<SetSynchronizationPoint xmlns="${NS_MEDIA}"><ProfileToken>${escapeXml(token)}</ProfileToken></SetSynchronizationPoint>`);
  }

  /** The RTP-Multicast URI, or '' when the camera has none.  The spec's
   *  transport for it is UDP; some cameras only accept RTSP there. */
  async multicastUri(token) {
    for (const protocol of ['UDP', 'RTSP']) {
      try {
        const uri = await this.streamUri(token, 'RTP-Multicast', protocol);
        if (uri) return uri;
      } catch (err) { if (err.auth) throw err; }
    }
    return '';
  }
}

/** Put credentials into an RTSP URI (and our host, if the camera advertised another). */
function withCredentials(uri, host, user, pass) {
  try {
    const u = new URL(uri.replace(/^rtsp:/i, 'http:'));
    if (host && /^(0\.0\.0\.0|127\.|localhost)/.test(u.hostname)) u.hostname = host;
    if (user) { u.username = encodeURIComponent(user); u.password = encodeURIComponent(pass || ''); }
    if (!u.port) u.port = '554';
    return u.toString().replace(/^http:/i, 'rtsp:');
  } catch { return uri; }
}

/**
 * @returns {{streams: Array, suggested: {main, sub}}}
 * throws with a readable message (err.auth for credential failures)
 */
async function discover({ host, port = 80, user = '', pass = '' }) {
  if (!host) throw new Error('No camera address given');
  const c = new OnvifClient({ host, port, user, pass });
  try {
    await c.syncClock();
    await c.findMedia();
    const profiles = await c.profiles();
    const streams = [];
    for (const { group, ...p } of profiles) {
      try {
        const raw = await c.streamUri(p.token);
        if (!raw) continue;
        const mraw = await c.multicastUri(p.token);
        const multicast = mraw || group ? {
          rtspUrl: mraw ? withCredentials(mraw, host, user, pass) : '',
          address: group ? group.address : null, port: group ? group.port : null,
          ttl: group ? group.ttl : null, autoStart: group ? group.autoStart : false,
        } : null;
        streams.push({ ...p, rawUri: raw, rtspUrl: withCredentials(raw, host, user, pass), multicast });
      } catch (err) { if (err.auth) throw err; }
    }
    const seen = new Set();
    const unique = streams.filter((s) => (seen.has(s.rtspUrl) ? false : seen.add(s.rtspUrl)));
    const byArea = [...unique].sort((a, b) => (b.width * b.height || 0) - (a.width * a.height || 0));
    const main = byArea[0]?.rtspUrl || '';
    const smallest = byArea[byArea.length - 1];
    const sub = byArea.length > 1 && smallest.rtspUrl !== main ? smallest.rtspUrl : '';
    const mcOf = (url) => (unique.find((s) => s.rtspUrl === url)?.multicast?.rtspUrl) || '';
    return {
      streams: unique,
      // mainMulticast / subMulticast: the RTSP address to ask for each one as multicast ('' if none).
      suggested: { main, sub, mainMulticast: main ? mcOf(main) : '', subMulticast: sub ? mcOf(sub) : '' },
    };
  } catch (err) {
    if (/ECONNREFUSED/.test(err.message)) throw new Error(`Nothing is answering ONVIF on ${host}:${port}`);
    if (/EHOSTUNREACH|ENETUNREACH/.test(err.message)) throw new Error(`${host} cannot be reached`);
    throw err;
  }
}

/** An RTSP URL reduced to what identifies a stream: host, port, path and query, no credentials. */
function streamKey(url) {
  try {
    const u = new URL(String(url).replace(/^rtsps?:/i, 'http:'));
    return `${u.hostname.toLowerCase()}:${u.port || '554'}${u.pathname}${u.search}`;
  } catch { return String(url); }
}

/**
 * Multicast for a camera that is already set up: ask it over ONVIF, with the
 * credentials in its own RTSP URL, and match each of its RTSP sources to a
 * discovered stream (same address, else main/sub as ONVIF suggests them).
 * @returns {{sources: Array<{label, matched, multicast}>}} multicast as in discover(); throws like discover()
 */
async function lookupMulticast(cam, { port = 80 } = {}) {
  const rtsp = (cam.sources || []).filter((s) => (s.type || '') === 'rtsp' || /^rtsps?:/i.test(s.url || ''));
  if (!rtsp.length) throw new Error('No RTSP streams');
  const u = new URL(rtsp[0].url.replace(/^rtsps?:/i, 'http:'));
  const d = await discover({
    host: u.hostname, port,
    user: decodeURIComponent(u.username || ''), pass: decodeURIComponent(u.password || ''),
  });
  // Something answered on the port (a UniFi Protect console does) but it is
  // not an ONVIF camera; "no multicast" would claim we asked it.
  if (!d.streams.length) throw new Error(`ONVIF on ${u.hostname}:${port} listed no video streams (not an ONVIF camera?)`);
  const byKey = new Map(d.streams.map((st) => [streamKey(st.rtspUrl), st]));
  const byUrl = new Map(d.streams.map((st) => [st.rtspUrl, st]));
  return {
    sources: rtsp.map((src) => {
      let st = byKey.get(streamKey(src.url));
      let matched = st ? 'address' : null;
      if (!st) {
        const want = src.label === 'main' ? d.suggested.main : src.label === 'sub' ? d.suggested.sub : '';
        st = want ? byUrl.get(want) : null;
        if (st) matched = src.label;
      }
      return { label: src.label, matched, profileName: st ? st.profileName : null, multicast: st ? st.multicast : null };
    }),
  };
}

/**
 * Keyframes on request.  After lost packets a stream's picture is held until
 * the next keyframe (stream-session.js _onRtpLoss); a camera asked over ONVIF
 * sends one at once instead of at the end of its keyframe interval (the
 * Uniview Temple cameras: 40-100 ms after the request, 2026-11-12), so the
 * freeze is that much shorter.  It changes no camera setting, and the
 * keyframe goes to every receiver of the stream, multicast included.
 *
 * One ONVIF client per stream, made on first use: the profile is the one
 * whose RTSP address is the stream's, else main = the largest and sub = the
 * smallest.  A camera that does not answer, rejects the login or has no such
 * profile is asked again after 30 s, then left alone for `retryMs`.  At most
 * one request per stream every `minMs`.
 */
class KeyframeRequester {
  constructor({ minMs = 1000, retryMs = 10 * 60000, port = 80 } = {}) {
    this.minMs = minMs; this.retryMs = retryMs; this.port = port;
    this.entries = new Map();   // "id/label" -> { url, client, token, lastAt, skipUntil, fails, busy, error }
  }

  async _find(cam, src) {
    const u = new URL(src.url.replace(/^rtsps?:/i, 'http:'));
    const c = new OnvifClient({
      host: u.hostname, port: cam.onvifPort || this.port,
      user: decodeURIComponent(u.username || ''), pass: decodeURIComponent(u.password || ''),
    });
    await c.syncClock();
    await c.findMedia();
    const profiles = await c.profiles();
    const want = streamKey(src.url);
    for (const p of profiles) {
      const uri = await c.streamUri(p.token).catch((err) => { if (err.auth) throw err; return ''; });
      if (uri && streamKey(withCredentials(uri, u.hostname, '', '')) === want) return { client: c, token: p.token };
    }
    const byArea = [...profiles].sort((a, b) => (b.width * b.height || 0) - (a.width * a.height || 0));
    const p = byArea.length < 2 ? null : src.label === 'main' ? byArea[0] : src.label === 'sub' ? byArea[byArea.length - 1] : null;
    if (!p) throw new Error('no ONVIF profile matches this stream');
    return { client: c, token: p.token };
  }

  /**
   * Ask `cam` for a keyframe on its source `src`.  Never throws.
   * @returns {Promise<'sent'|'limited'|'unsupported'|'failed'>} 'failed' once per failure (see error()), 'unsupported' while the camera is left alone
   */
  async request(cam, src) {
    if (!cam || !src || !/^rtsps?:/i.test(src.url || '')) return 'unsupported';
    const key = `${cam.id}/${src.label}`;
    let e = this.entries.get(key);
    if (!e || e.url !== src.url) {   // new, or the camera was edited
      e = { url: src.url, client: null, token: null, lastAt: 0, skipUntil: 0, fails: 0, busy: false, error: null };
      this.entries.set(key, e);
    }
    const now = Date.now();
    if (now < e.skipUntil) return 'unsupported';
    if (e.busy || now - e.lastAt < this.minMs) return 'limited';
    e.busy = true; e.lastAt = now;
    try {
      if (!e.client) Object.assign(e, await this._find(cam, src));
      await e.client.syncPoint(e.token);
      e.fails = 0; e.error = null;
      return 'sent';
    } catch (err) {
      e.client = null; e.token = null; e.error = err.message;
      e.skipUntil = Date.now() + (e.fails++ ? this.retryMs : 30000);
      return 'failed';
    } finally { e.busy = false; }
  }

  error(camId, label) { return this.entries.get(`${camId}/${label}`)?.error || null; }
}

/**
 * Streams that send to the same multicast group and port as another stream.
 * Dahua cameras all ship with group 224.1.2.4 and the same ports, so two of
 * them on multicast arrive mixed at every receiver until each camera is given
 * its own address.
 * @param {Array<{key, address, port}>} entries
 * @returns {Map<string, string[]>} key -> the other keys on its group and port
 */
function sharedGroups(entries) {
  const byGroup = new Map();
  for (const e of entries) {
    const g = `${e.address}:${e.port}`;
    byGroup.set(g, [...(byGroup.get(g) || []), e.key]);
  }
  const out = new Map();
  for (const keys of byGroup.values()) {
    if (keys.length > 1) for (const k of keys) out.set(k, keys.filter((x) => x !== k));
  }
  return out;
}

module.exports = { OnvifClient, KeyframeRequester, discover, withCredentials, lookupMulticast, streamKey, sharedGroups };
