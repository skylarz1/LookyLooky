'use strict';
/**
 * The old standalone camera-proxy.js, kept as endpoints so anything written
 * against it (camera-1.htm, scripts, a <video src>) keeps working:
 *
 *   GET /cameras         list of enabled cameras
 *   GET /stream/:id      for an HTTP camera: its live stream, byte for byte,
 *                        with Basic or session-cookie login done for you;
 *                        for any other camera: redirected to its MJPEG feed
 *   GET /snapshot/:id    one JPEG
 *
 * Same behaviour as the original: a 401/403 or a JSON "no_login" error body
 * (some cameras answer a dead session with JSON under content-type video/mp4)
 * clears the session and retries once.
 */

const http = require('http');
const https = require('https');
const { getSession, clearSession, buildUrl, basicHeader } = require('./sources');

function sendJson(res, code, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

async function proxy(camera, source, url, res, retry = 0) {
  const parsed = new URL(url);
  const headers = { 'User-Agent': 'lookylooky/1.0' };
  const key = `proxy:${camera.id}`;
  if (source.auth?.username) {
    if (source.auth.authType === 'session') {
      const cookie = await getSession(key, url, source.auth, (m) => console.log(`[proxy ${camera.id}] ${m}`));
      if (!cookie) { sendJson(res, 401, { error: `Could not authenticate with camera '${camera.id}'` }); return; }
      headers.Cookie = cookie;
    } else headers.Authorization = basicHeader(source.auth);
  }
  const transport = parsed.protocol === 'https:' ? https : http;
  const camReq = transport.request({
    hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search, method: 'GET', headers, rejectUnauthorized: false,
  }, (camRes) => {
    if ((camRes.statusCode === 401 || camRes.statusCode === 403) && retry < 1) {
      clearSession(key); camRes.resume(); proxy(camera, source, url, res, retry + 1); return;
    }
    let first = true;
    camRes.on('data', (chunk) => {
      if (first) {
        first = false;
        const peek = chunk.toString('utf8', 0, 64).trim();
        if (peek.startsWith('{') && (peek.includes('error_code') || peek.includes('no_login'))) {
          camRes.destroy();
          if (retry < 1) { clearSession(key); proxy(camera, source, url, res, retry + 1); }
          else sendJson(res, 401, { error: `Camera '${camera.id}' rejected stream after re-authentication` });
          return;
        }
        res.writeHead(camRes.statusCode === 200 ? 200 : camRes.statusCode, {
          'Content-Type': camRes.headers['content-type'] || 'video/mp4',
          'Cache-Control': 'no-cache, no-store', Connection: 'close', 'Access-Control-Allow-Origin': '*',
        });
      }
      if (!res.destroyed) res.write(chunk);
    });
    camRes.on('end', () => { if (!res.destroyed && res.headersSent) res.end(); });
    camRes.on('error', () => res.destroy());
    res.on('close', () => camRes.destroy());
  });
  camReq.on('error', (err) => {
    if (!res.headersSent) sendJson(res, 502, { error: `Cannot reach camera '${camera.id}': ${err.message}` });
    else res.destroy();
  });
  camReq.setTimeout(10000, () => {
    camReq.destroy();
    if (!res.headersSent) sendJson(res, 504, { error: `Timeout connecting to camera '${camera.id}'` });
  });
  camReq.end();
}

function register(router, manager) {
  router.get('/cameras', (req, res) => {
    sendJson(res, 200, manager.cameras.filter((c) => c.enabled).map((c) => ({
      id: c.id, name: c.name, streamUrl: `/stream/${c.id}`, snapshotUrl: `/snapshot/${c.id}`,
      mjpegUrl: `/stream/${c.id}/mjpeg`,
    })));
  });

  router.get('/stream/:id', (req, res, { id }) => {
    const cam = manager.camera(id);
    if (!cam || !cam.enabled) return sendJson(res, 404, { error: `Camera '${id}' not found` });
    const src = cam.sources.find((s) => s.type === 'http');
    if (!src) { res.writeHead(302, { Location: `/stream/${encodeURIComponent(id)}/mjpeg` }); res.end(); return; }
    proxy(cam, src, buildUrl(src), res);
  });

  router.get('/snapshot/:id', async (req, res, { id }) => {
    const cam = manager.camera(id);
    if (!cam || !cam.enabled) return sendJson(res, 404, { error: `Camera '${id}' not found` });
    const src = cam.sources.find((s) => s.type === 'http');
    if (src && (src.snapshotUrl || /live\.mp4/.test(src.url))) {
      proxy(cam, src, src.snapshotUrl || src.url.replace(/live\.mp4.*/, 'snapshot.jpg'), res);
      return;
    }
    res.writeHead(302, { Location: `/stream/${encodeURIComponent(id)}/snapshot` });
    res.end();
  });
}

module.exports = { register };
