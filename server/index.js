#!/usr/bin/env node
'use strict';
/**
 * LookyLooky — network camera relay.
 *
 *   HTTP   :8080  (LOOKY_HTTP_PORT)   everything; what a reverse proxy should point at
 *   HTTPS  :8443  (LOOKY_HTTPS_PORT)  everything, with a locally-issued certificate,
 *                                     so LAN browsers get the secure context WebCodecs needs
 *
 * Both serve the same pages, API and media socket (/cameras/stream).
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');

const { Store, parseImport, DATA_DIR } = require('./config');
const { CameraManager } = require('./cameras');
const { Recorder } = require('./recordings');
const { StreamHub } = require('./ws-server');
const { Router, sendError, sendFile, checkAuth, cors } = require('./http-util');
const api = require('./api');
const legacy = require('./legacy-proxy');
const { ensureCertificates } = require('./tls');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const HTTP_PORT = Number(process.env.LOOKY_HTTP_PORT || 8080);
const HTTPS_PORT = Number(process.env.LOOKY_HTTPS_PORT || 8443);
const HTTPS_ON = process.env.LOOKY_HTTPS !== '0';

const store = new Store();
const manager = new CameraManager(store);
const recorder = new Recorder(manager);
const allowed = String(process.env.LOOKY_ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
const hub = new StreamHub(manager, { allowedOrigins: allowed });
manager.hub = hub;

const info = {
  startedAt: Date.now(),
  publicHttpPort: Number(process.env.LOOKY_PUBLIC_HTTP_PORT || HTTP_PORT),
  publicHttpsPort: HTTPS_ON ? Number(process.env.LOOKY_PUBLIC_HTTPS_PORT || HTTPS_PORT) : 0,
  tls: null,
};

const router = new Router();
legacy.register(router, manager);
const { importFiles } = api.register(router, { store, manager, recorder, hub, info });

/* --- first boot: seed from the mounted config folder ----------------------- */

function seed() {
  if (!store.firstBoot) return;
  const dir = process.env.LOOKY_SEED_DIR || (fs.existsSync('/seed') ? '/seed' : path.join(__dirname, '..', 'config'));
  const files = [];
  try {
    for (const n of fs.readdirSync(dir)) {
      if (/\.(xml|json)$/i.test(n) && !/example/i.test(n)) files.push({ name: n, text: fs.readFileSync(path.join(dir, n), 'utf8') });
    }
  } catch { /* no seed folder */ }
  if (files.length) {
    // Camera files before layout files, so a layout never names a camera that does not exist yet.
    files.sort((a, b) => Number(/layout/i.test(a.name)) - Number(/layout/i.test(b.name)));
    const r = importFiles(files);
    console.log(`[boot] first run — seeded from ${dir}: ${r.message}`);
  }
  if (store.cameras.length === 0 && process.env.LOOKY_DEMO !== '0') {
    store.cameras.push({ id: 'test-pattern', name: 'Test Pattern', group: 'Demo', enabled: true,
      sources: [{ label: 'main', type: 'test', url: 'test:1280x720@25', transport: 'tcp' }, { label: 'sub', type: 'test', url: 'test:640x360@25', transport: 'tcp' }] });
    store.layouts = [{ id: 'default', name: 'Default', description: '', gridType: '2x2', slots: { 0: { cameraId: 'test-pattern', streamType: 'webcodecs' } } }];
    console.log('[boot] no cameras configured — added a Test Pattern camera');
  }
  store.saveCameras();
  store.saveLayouts();
}

/* --- static files ------------------------------------------------------------ */

const ALIASES = {
  '/': '/index.html',
  '/cameras.htm': '/cameras.html', '/dashboard': '/cameras.html',
  '/camera-view.htm': '/camera-view.html', '/view.html': '/camera-view.html', '/view': '/camera-view.html',
  '/wall': '/wall.html', '/setup': '/setup.html', '/camera-1.htm': '/camera-1.html',
};
const ADMIN_PAGES = new Set(['/cameras.html']);

function templ(text) {
  return text
    .replace(/\[LookyLooky\.Port\]/g, String(info.publicHttpPort))
    .replace(/\[LookyLooky\.SecurePort\]/g, String(info.publicHttpsPort || 0))
    .replace(/\[LookyLooky\.Version\]/g, api.VERSION);
}

function serveStatic(req, res, pathname) {
  const p = ALIASES[pathname] || pathname;
  if (p === '/ca.crt') {
    const ca = path.join(DATA_DIR, 'certs', 'ca.crt');
    if (!fs.existsSync(ca)) return sendError(res, 404, 'No local CA (HTTPS is off, or a custom certificate is in use)');
    return sendFile(req, res, ca, { download: true });
  }
  if (ADMIN_PAGES.has(p) && !checkAuth(req, res)) return;
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendError(res, 403, 'Forbidden');
  const isHtml = /\.html?$/.test(file);
  sendFile(req, res, file, { transform: isHtml ? templ : null, cache: isHtml ? 'no-store' : 'no-cache' });
}

/* --- request handling --------------------------------------------------------- */

async function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://local'); } catch { return sendError(res, 400, 'Bad URL'); }
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const m = router.match(req.method, url.pathname);
  if (m) {
    try { await m.route.handler(req, res, m.params, url); }
    catch (err) {
      if (!err.status || err.status >= 500) console.error(`[http] ${req.method} ${url.pathname}:`, err);
      sendError(res, err.status || 500, err.message);
    }
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Method not allowed');
  if (url.pathname.startsWith('/api/')) return sendError(res, 404, 'No such endpoint');
  serveStatic(req, res, url.pathname);
}

function listen(server, port, label) {
  hub.attach(server);
  server.keepAliveTimeout = 65000;
  server.listen(port, '0.0.0.0', () => console.log(`[boot] ${label} on :${port}`));
  server.on('error', (err) => { console.error(`[boot] ${label} :${port} failed: ${err.message}`); process.exit(1); });
}

/**
 * The HTTPS port also answers plain HTTP, with a redirect to HTTPS on the
 * same host and port.  Someone typing http://box:8443 gets the secure page
 * instead of a browser error.  The first byte of a connection tells the two
 * apart: a TLS handshake always starts with 0x16.
 */
function listenDual(tlsServer, port) {
  hub.attach(tlsServer);
  tlsServer.keepAliveTimeout = 65000;
  const redirect = http.createServer((req, res) => {
    const host = req.headers.host || `localhost:${port}`;
    res.writeHead(301, { Location: `https://${host}${req.url || '/'}`, 'Cache-Control': 'no-store' });
    res.end();
  });
  // A WebSocket opened with ws:// on this port gets the same answer.
  redirect.on('upgrade', (req, socket) => {
    socket.end(`HTTP/1.1 301 Moved Permanently\r\nLocation: https://${req.headers.host}${req.url}\r\n\r\n`);
  });
  const front = net.createServer((sock) => {
    sock.once('data', (buf) => {
      sock.pause();
      sock.unshift(buf);
      (buf[0] === 0x16 ? tlsServer : redirect).emit('connection', sock);
      process.nextTick(() => sock.resume());
    });
    sock.on('error', () => { /* client went away */ });
  });
  front.listen(port, '0.0.0.0', () => console.log(`[boot] HTTPS on :${port} (plain HTTP there is redirected to HTTPS)`));
  front.on('error', (err) => { console.error(`[boot] HTTPS :${port} failed: ${err.message}`); process.exit(1); });
}

seed();
listen(http.createServer(handle), HTTP_PORT, 'HTTP');
if (HTTPS_ON) {
  try {
    const t = ensureCertificates(DATA_DIR);
    info.tls = { custom: t.custom, names: t.names, caUrl: t.ca ? '/ca.crt' : null };
    listenDual(https.createServer({ cert: t.cert, key: t.key }, handle), HTTPS_PORT);
  } catch (err) {
    console.error(`[boot] HTTPS disabled — certificate setup failed: ${err.message}`);
    info.publicHttpsPort = 0;
  }
}

console.log(`[boot] LookyLooky ${api.VERSION} — data in ${DATA_DIR}, ${store.cameras.length} camera(s), ${store.layouts.length} layout(s)`);
manager.probeAll().catch(() => {});
manager.applyKeepWarm();
setInterval(() => { manager.killStrays(); manager.probeAll().catch(() => {}); },
  Math.max(10000, store.settings.ffmpeg.watchdogIntervalMs || 60000)).unref();

/* --- signals ------------------------------------------------------------------- */

// Like the old camera-proxy: SIGHUP re-reads cameras.json and layouts.json.
process.on('SIGHUP', () => {
  try {
    const fresh = new Store();
    store.cameras.splice(0, store.cameras.length, ...fresh.cameras);
    store.layouts.splice(0, store.layouts.length, ...fresh.layouts);
    store.settings = fresh.settings;
    manager.recycle();
    console.log(`[boot] reloaded: ${store.cameras.length} camera(s)`);
  } catch (err) { console.error(`[boot] reload failed: ${err.message}`); }
});

let stopping = false;
function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  console.log(`[boot] ${sig} — shutting down`);
  recorder.shutdown();
  hub.closeAll(1001, 'server shutting down');
  setTimeout(() => { manager.shutdown(); process.exit(0); }, recorder.active ? 3000 : 300);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => console.error('[fatal?] uncaught:', err));
process.on('unhandledRejection', (err) => console.error('[fatal?] unhandled rejection:', err));

module.exports = { parseImport };
