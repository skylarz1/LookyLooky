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
 *
 * Server → client: JSON acks ({ type:'subscribed' | 'error', … }) and the
 * binary messages in protocol.js.  A socket that never subscribes is fine:
 * the dashboard keeps one open so the server can count connected browsers.
 */

const { WebSocketServer } = require('ws');
const P = require('./protocol');
const { SOFT_CAP, HARD_CAP } = require('./stream-session');

const THUMB_CAP = 512 * 1024;

class Viewer {
  constructor(ws, hub, req) {
    this.ws = ws;
    this.hub = hub;
    this.addr = req.socket.remoteAddress;
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
        this.json({ type: 'pong', t: Date.now() });
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
