'use strict';
/**
 * The media WebSocket: /cameras/stream (also answered at / and /stream for
 * clients written against the camera server's socket root).
 *
 * One socket carries one subscription — a pane opens its own.  Client → server
 * messages are JSON:
 *
 *   { action: 'subscribe', cameraId, quality?, audio?: 'opus'|'pcm'|'none', audioEnabled?: bool }
 *   { action: 'unsubscribe' }
 *   { action: 'audio', enabled: bool }       start/stop sending audio to this pane
 *   { action: 'subscribeThumb', cameraId }   JPEG thumbnail tier
 *   { action: 'unsubscribeThumb' }
 *   { action: 'ping', c? }                   pong carries `mono`, the server clock video PTS use (ms)
 *   { action: 'report', fps, dropped, … }     what the pane got, every 5 s (statistics page)
 *
 * Server → client: JSON acks ({ type:'subscribed' | 'error', … }) and the
 * binary messages in protocol.js.  A socket that never subscribes is fine:
 * the dashboard keeps one open so the server can count connected browsers.
 */

const { WebSocketServer } = require('ws');
const P = require('./protocol');
const { SOFT_CAP, HARD_CAP } = require('./stream-session');

const THUMB_CAP = 512 * 1024;
const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000;  // stream-session's PTS clock
let nextId = 1;

/** A viewer's report, reduced to the fields and types the statistics page shows. */
function cleanReport(msg) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const spread = (o) => (o && typeof o === 'object' ? { p50: num(o.p50), p95: num(o.p95), max: num(o.max) } : null);
  const out = { at: Date.now() };
  for (const k of ['fps', 'dropped', 'decodeQueue', 'videoQueue', 'reanchors', 'inputShed', 'pausedDrops', 'rebuilds', 'rttMs']) out[k] = num(msg[k]);
  out.software = msg.software === true;
  out.visible = msg.visible !== false;
  out.arrival = spread(msg.arrival);
  out.render = spread(msg.render);
  return out;
}

class Viewer {
  constructor(ws, hub, req) {
    this.ws = ws;
    this.hub = hub;
    this.id = nextId++;
    this.addr = req.socket.remoteAddress;
    this.forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null;
    this.userAgent = String(req.headers['user-agent'] || '').slice(0, 200);
    this.skips = 0;
    this.report = null;
    this.session = null;
    this.thumb = null;
    this.configSent = false;
    this.skipping = false;
    this.audioMode = 'opus';
    this.audioOn = true;
    this.bytesOut = 0;
    this.connectedAt = Date.now();
  }

  send(buf) {
    if (this.ws.readyState !== 1) return;
    this.ws.send(buf, { binary: typeof buf !== 'string' });
    this.bytesOut += buf.length;
    if (this.session) this.session.stats.bytesOut += buf.length;
  }

  json(obj) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  close(code, reason) { try { this.ws.close(code, reason); } catch { /* already closing */ } }

  detach() { this.session = null; this.configSent = false; }

  /** Config, then (on a fresh join) the cached GOP flagged as catch-up. */
  sendConfig(session, catchup = false) {
    this.send(session.videoConfigMsg);
    if (this.audioMode === 'opus' && session.audioConfigMsg) this.send(session.audioConfigMsg);
    this.configSent = true;
    this.skipping = false;
    if (catchup) for (const m of session.gop) this.send(P.asCatchup(m));
  }

  sendVideo(msg, isKey, session) {
    if (!this.configSent) return;
    const buffered = this.ws.bufferedAmount;
    if (buffered > HARD_CAP) {
      session.stats.kicks++;
      this.close(1013, 'slow consumer');
      return;
    }
    if (this.skipping) {
      if (!isKey || buffered > SOFT_CAP / 2) return;
      this.skipping = false;
    } else if (buffered > SOFT_CAP) {
      this.skipping = true;
      this.skips++;
      session.stats.skips++;
      return;
    }
    this.send(msg);
  }

  sendAudio(msg) {
    if (!this.configSent || !this.audioOn || this.ws.bufferedAmount > SOFT_CAP) return;
    this.send(msg);
  }

  sendJpeg(msg) {
    if (this.ws.bufferedAmount > THUMB_CAP) return;
    this.send(msg);
  }

  /**
   * For /api/stats.  `queueMs` is the socket backlog in time at the stream's
   * bitrate: the lag this server is adding.  The delays from the viewer's
   * report have the stream's own input delay (ptsLagMs) taken off, so they
   * are server -> arrival and server -> screen.
   */
  info() {
    const s = this.session;
    const r = this.report && Date.now() - this.report.at < 15000 ? this.report : null;
    const buffered = this.ws.bufferedAmount;
    const bps = s ? s._bpsSample.bps / Math.max(1, s.clients.size) : 0;
    const minus = (spread) => {
      if (!spread || s?.ptsLagMs == null) return null;
      const o = {};
      for (const k of ['p50', 'p95', 'max']) o[k] = spread[k] == null ? null : Math.round(spread[k] - s.ptsLagMs);
      return o;
    };
    return {
      id: this.id, addr: this.forwardedFor || this.addr, userAgent: this.userAgent,
      connectedAt: this.connectedAt, cameraId: s?.cameraId || (this.thumb ? this.thumb.cameraId : null),
      variant: s ? s.label : (this.thumb ? 'thumb' : null),
      bytesOut: this.bytesOut, queueKB: Math.round(buffered / 1024),
      queueMs: bps > 0 ? Math.round((buffered / bps) * 1000) : 0,
      skipping: this.skipping, skips: this.skips,
      report: r && { ...r, arrival: minus(r.arrival), render: minus(r.render) },
    };
  }

  unsubscribe() {
    if (this.session) { this.session.removeClient(this); this.session = null; }
    if (this.thumb) { this.thumb.removeClient(this); this.thumb = null; }
    this.configSent = false;
  }

  onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    const mgr = this.hub.manager;
    switch (msg.action) {
      case 'subscribe': {
        this.unsubscribe();
        const cam = mgr.camera(msg.cameraId);
        if (!cam) {
          this.json({ type: 'error', message: `Unknown camera '${msg.cameraId}'` });
          this.send(P.streamError(`Unknown camera '${msg.cameraId}'`));
          return;
        }
        if (!cam.enabled) { this.send(P.streamError('The camera is stopped')); return; }
        this.audioMode = ['opus', 'pcm', 'none'].includes(msg.audio) ? msg.audio : 'opus';
        this.audioOn = msg.audioEnabled !== false;
        const session = mgr.session(cam.id, msg.quality);
        if (!session) { this.send(P.streamError('The camera has no stream configured')); return; }
        this.session = session;
        this.json({ type: 'subscribed', cameraId: cam.id, quality: session.label });
        session.addClient(this);
        break;
      }
      case 'unsubscribe':
        this.unsubscribe();
        this.json({ type: 'unsubscribed' });
        break;
      case 'audio':
        this.audioOn = !!msg.enabled;
        break;
      case 'subscribeThumb': {
        this.unsubscribe();
        const cam = mgr.camera(msg.cameraId);
        if (!cam || !cam.enabled) { this.json({ type: 'error', message: 'camera unavailable' }); return; }
        this.thumb = mgr.mjpeg(cam.id);
        this.thumb.addClient(this);
        this.json({ type: 'subscribed', cameraId: cam.id, quality: 'thumb' });
        break;
      }
      case 'unsubscribeThumb':
        this.unsubscribe();
        break;
      case 'ping':
        this.json({ type: 'pong', t: Date.now(), mono: nowMs(), c: typeof msg.c === 'number' ? msg.c : undefined });
        break;
      case 'report':
        this.report = cleanReport(msg);
        break;
      default:
        break;
    }
  }
}

class StreamHub {
  constructor(manager, { allowedOrigins } = {}) {
    this.manager = manager;
    this.viewers = new Set();
    this.allowedOrigins = allowedOrigins;
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 });
    this.wss.on('connection', (ws, req) => {
      const v = new Viewer(ws, this, req);
      this.viewers.add(v);
      ws.on('message', (data, isBinary) => { if (!isBinary) v.onMessage(data.toString()); });
      ws.on('close', () => { v.unsubscribe(); this.viewers.delete(v); });
      ws.on('error', () => { /* close follows */ });
    });
  }

  /** Attach to an http(s) server's upgrade event. */
  attach(server) {
    server.on('upgrade', (req, socket, head) => {
      const path = (req.url || '/').split('?')[0];
      if (!['/cameras/stream', '/stream', '/'].includes(path)) { socket.destroy(); return; }
      if (this.allowedOrigins && req.headers.origin && !this.allowedOrigins.includes('*')) {
        let host = '';
        try { host = new URL(req.headers.origin).host; } catch { /* ignore */ }
        const same = host === req.headers.host;
        if (!same && !this.allowedOrigins.includes(req.headers.origin)) { socket.destroy(); return; }
      }
      // Low latency: never let Nagle hold a frame back.
      socket.setNoDelay(true);
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
  }

  closeAll(code = 1012, reason = 'recycle') {
    const n = this.viewers.size;
    for (const v of this.viewers) v.close(code, reason);
    return n;
  }
}

module.exports = { StreamHub };
