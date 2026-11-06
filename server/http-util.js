'use strict';
/** Small HTTP toolkit: a router, JSON in/out, static files with Range, auth. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.crt': 'application/x-x509-ca-cert',
};

class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handler, opts });
  }
  get(p, h, o) { this.add('GET', p, h, o); }
  post(p, h, o) { this.add('POST', p, h, o); }
  put(p, h, o) { this.add('PUT', p, h, o); }
  delete(p, h, o) { this.add('DELETE', p, h, o); }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(m[i + 1]); } catch { params[k] = m[i + 1]; } });
      return { route: r, params };
    }
    return null;
  }
}

function sendJson(res, code, data) {
  if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

const sendError = (res, code, message, extra = {}) => sendJson(res, code, { error: message, ...extra });

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw Object.assign(new Error('Body is not valid JSON'), { status: 400 }); }
}

/** Server-sent events on a response. */
function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': ok\n\n');
  return (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
}

/** Serve a file, honouring Range (Safari will not play a video without it). */
function sendFile(req, res, file, { download = false, cache = 'no-cache', transform = null } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return sendError(res, 404, 'Not found'); }
  if (!st.isFile()) return sendError(res, 404, 'Not found');
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': cache, 'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString() };
  if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(file).replace(/"/g, '')}"`;

  if (transform) {
    const body = Buffer.from(transform(fs.readFileSync(file, 'utf8')));
    headers['Content-Length'] = body.length;
    delete headers['Accept-Ranges'];
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  headers.ETag = etag;
  if (req.headers['if-none-match'] === etag && !req.headers.range) { res.writeHead(304, headers); res.end(); return; }

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    if (start < 0) start = 0;
    if (end >= st.size) end = st.size - 1;
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}

/** Basic auth when LOOKY_ADMIN_PASSWORD is set; true when the request may proceed. */
function checkAuth(req, res, realm = 'LookyLooky admin') {
  const pass = process.env.LOOKY_ADMIN_PASSWORD;
  if (!pass) return true;
  const user = process.env.LOOKY_ADMIN_USER || 'admin';
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (m) {
    const [u, ...rest] = Buffer.from(m[1], 'base64').toString().split(':');
    const p = rest.join(':');
    const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
    if (eq(u, user) && eq(p, pass)) return true;
  }
  res.writeHead(401, { 'WWW-Authenticate': `Basic realm="${realm}", charset="UTF-8"`, 'Content-Type': 'text/plain' });
  res.end('Authentication required');
  return false;
}

function cors(req, res) {
  const allowed = String(process.env.LOOKY_ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  const origin = req.headers.origin;
  if (!origin) return;
  if (allowed.includes('*') || allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', allowed.includes('*') ? '*' : origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (!allowed.includes('*')) res.setHeader('Vary', 'Origin');
  }
}

module.exports = { Router, sendJson, sendError, readJson, readBody, sse, sendFile, checkAuth, cors, MIME };
