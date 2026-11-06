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
      return {
        token: attr(p.attrs, 'token'),
        profileName: unescape(tag(p.body, 'Name') || attr(p.attrs, 'token') || 'Profile'),
        encoding: enc ? (tag(enc.body, 'Encoding') || '').toLowerCase() : null,
        width: res ? Number(tag(res.body, 'Width')) || null : null,
        height: res ? Number(tag(res.body, 'Height')) || null : null,
      };
    }).filter((p) => p.token);
  }

  async streamUri(token) {
    const xml = await this.call(this.mediaUrl,
      `<GetStreamUri xmlns="${NS_MEDIA}"><StreamSetup><Stream xmlns="${NS_SCHEMA}">RTP-Unicast</Stream>`
      + `<Transport xmlns="${NS_SCHEMA}"><Protocol>RTSP</Protocol></Transport></StreamSetup>`
      + `<ProfileToken>${escapeXml(token)}</ProfileToken></GetStreamUri>`);
    return unescape(tag(xml, 'Uri') || '');
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
    for (const p of profiles) {
      try {
        const raw = await c.streamUri(p.token);
        if (!raw) continue;
        streams.push({ ...p, rawUri: raw, rtspUrl: withCredentials(raw, host, user, pass) });
      } catch (err) { if (err.auth) throw err; }
    }
    const seen = new Set();
    const unique = streams.filter((s) => (seen.has(s.rtspUrl) ? false : seen.add(s.rtspUrl)));
    const byArea = [...unique].sort((a, b) => (b.width * b.height || 0) - (a.width * a.height || 0));
    const main = byArea[0]?.rtspUrl || '';
    const smallest = byArea[byArea.length - 1];
    const sub = byArea.length > 1 && smallest.rtspUrl !== main ? smallest.rtspUrl : '';
    return { streams: unique, suggested: { main, sub } };
  } catch (err) {
    if (/ECONNREFUSED/.test(err.message)) throw new Error(`Nothing is answering ONVIF on ${host}:${port}`);
    if (/EHOSTUNREACH|ENETUNREACH/.test(err.message)) throw new Error(`${host} cannot be reached`);
    throw err;
  }
}

module.exports = { discover, withCredentials };
