'use strict';
/**
 * MjpegSession — the JPEG tier for one camera.
 *
 * Feeds three kinds of consumer from one FFmpeg:
 *   • dashboard thumbnail panes, over the media WebSocket (JPEG_FRAME)
 *   • GET /stream/:id/mjpeg   multipart/x-mixed-replace, for third-party tools
 *   • GET /stream/:id/snapshot  the latest frame
 *
 * The FFmpeg does not open its own camera connection.  It reads the fMP4 the
 * camera's StreamSession already produces (thumbnail variant: `sub` when the
 * camera has one), so a camera that allows only a few RTSP sessions is not
 * asked for another one per tier.  Decoding starts at the cached GOP, so the
 * first JPEG is out within a frame or two of the session being live.
 */

const { spawn } = require('child_process');
const P = require('./protocol');

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

class MjpegSession {
  constructor(manager, cameraId) {
    this.manager = manager;
    this.cameraId = cameraId;
    this.clients = new Set();     // WS viewers
    this.httpClients = new Set(); // multipart responses
    this.waiters = [];            // snapshot callbacks
    this.proc = null;
    this.source = null;           // the StreamSession feeding us
    this.latest = null;
    this.latestAt = 0;
    this.buf = Buffer.alloc(0);
    this.frames = 0;
    this.idleTimer = null;
    this.restartTimer = null;
    this._raw = {
      onInit: (init) => this._startDecoder(init),
      onFragment: (frag) => this._write(frag),
      onReset: () => this._stopDecoder(),
    };
  }

  log(m) { console.log(`[mjpeg ${this.cameraId}] ${m}`); }

  get consumerCount() { return this.clients.size + this.httpClients.size + this.waiters.length; }

  _ensure() {
    clearTimeout(this.idleTimer); this.idleTimer = null;
    if (this.source) return;
    const s = this.manager.session(this.cameraId, this.manager.thumbVariant(this.cameraId));
    if (!s) return;
    this.source = s;
    s.addRaw(this._raw);
  }

  _maybeIdle() {
    if (this.consumerCount > 0) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (this.consumerCount === 0) this.stop(); }, 10000);
  }

  stop() {
    clearTimeout(this.idleTimer); this.idleTimer = null;
    this._stopDecoder();
    if (this.source) { this.source.removeRaw(this._raw); this.source = null; }
  }

  destroy() {
    this.stop();
    for (const res of this.httpClients) try { res.end(); } catch { /* gone */ }
    this.httpClients.clear();
    for (const w of this.waiters) w(null);
    this.waiters = [];
    for (const c of this.clients) c.thumb = null;
    this.clients.clear();
  }

  _startDecoder(init) {
    this._stopDecoder();
    const st = this.manager.store.settings;
    const m = st.mjpeg;
    const vf = [`fps=${Math.max(1, Number(m.fps) || 5)}`];
    if (m.scale) vf.push(`scale=${m.scale}`);
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error',
      // No +nobuffer here either: the probed packet is the GOP's keyframe.
      '-flags', 'low_delay', '-probesize', '65536', '-analyzeduration', '0',
      '-f', 'mp4', '-i', 'pipe:0',
      '-an', '-vf', vf.join(','), '-q:v', String(Math.min(31, Math.max(2, Number(m.quality) || 5))),
      '-f', 'mjpeg', '-flush_packets', '1', 'pipe:1'];
    const proc = spawn(st.ffmpeg.path || 'ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.manager.trackProcess(proc);
    let err = '';
    proc.stdin.on('error', () => { /* decoder went away */ });
    proc.stdout.on('data', (c) => this._onData(c));
    proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    proc.on('close', (code) => {
      this.manager.untrackProcess(proc);
      if (this.proc !== proc) return;
      this.proc = null;
      if (code && err) this.log(`decoder exited: ${err.trim().split('\n').pop()}`);
      // Died on its own while the camera is still live: re-attach, which
      // replays init + GOP and so restarts the decoder.
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        const s = this.source;
        if (!this.proc && s && this.consumerCount > 0) { s.removeRaw(this._raw); s.addRaw(this._raw); }
      }, 1000);
    });
    proc.stdin.write(init);
  }

  _stopDecoder() {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    try { p.stdin.end(); } catch { /* ignore */ }
    try { p.kill('SIGTERM'); } catch { /* ignore */ }
    this.buf = Buffer.alloc(0);
  }

  _write(frag) {
    const p = this.proc;
    if (!p || !p.stdin.writable) return;
    // Never queue unboundedly behind a slow decoder.
    if (p.stdin.writableLength > 8 * 1024 * 1024) return;
    p.stdin.write(frag);
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const s = this.buf.indexOf(SOI);
      if (s < 0) { this.buf = Buffer.alloc(0); return; }
      const e = this.buf.indexOf(EOI, s + 2);
      if (e < 0) { if (s > 0) this.buf = this.buf.subarray(s); return; }
      const jpeg = Buffer.from(this.buf.subarray(s, e + 2));
      this.buf = this.buf.subarray(e + 2);
      this._onFrame(jpeg);
    }
  }

  _onFrame(jpeg) {
    this.latest = jpeg;
    this.latestAt = Date.now();
    this.frames++;
    if (this.clients.size) {
      const msg = P.jpegFrame(jpeg);
      for (const c of this.clients) c.sendJpeg(msg);
    }
    if (this.httpClients.size) {
      const head = Buffer.from(`--lookyframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      for (const res of this.httpClients) {
        if (res.writableLength > 2 * 1024 * 1024) continue; // slow client: drop frames, not memory
        res.write(head); res.write(jpeg); res.write('\r\n');
      }
    }
    if (this.waiters.length) {
      const w = this.waiters; this.waiters = [];
      for (const fn of w) fn(jpeg);
      this._maybeIdle();
    }
  }

  /* --- consumers ---------------------------------------------------------- */

  addClient(v) {
    this.clients.add(v);
    this._ensure();
    if (this.latest && Date.now() - this.latestAt < 2000) v.sendJpeg(P.jpegFrame(this.latest));
  }
  removeClient(v) { this.clients.delete(v); this._maybeIdle(); }

  addHttp(req, res) {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=lookyframe',
      'Cache-Control': 'no-cache, no-store, must-revalidate', Pragma: 'no-cache', Connection: 'close',
      'Access-Control-Allow-Origin': '*',
    });
    res.socket?.setNoDelay(true);
    this.httpClients.add(res);
    this._ensure();
    const done = () => { this.httpClients.delete(res); this._maybeIdle(); };
    req.on('close', done);
    res.on('error', done);
  }

  /** Resolve with the freshest JPEG (waiting up to `timeoutMs` for one), or null. */
  snapshot(timeoutMs = 10000) {
    if (this.latest && Date.now() - this.latestAt < 1500) return Promise.resolve(this.latest);
    return new Promise((resolve) => {
      let done = false;
      const fn = (j) => { if (!done) { done = true; clearTimeout(t); resolve(j); } };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== fn);
        fn(this.latest);
        this._maybeIdle();
      }, timeoutMs);
      this.waiters.push(fn);
      this._ensure();
    });
  }

  info() {
    return {
      cameraId: this.cameraId, running: !!this.proc, pid: this.proc?.pid || null,
      wsClients: this.clients.size, httpClients: this.httpClients.size, frames: this.frames,
    };
  }
}

module.exports = { MjpegSession };
