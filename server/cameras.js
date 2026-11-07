'use strict';
/**
 * CameraManager — the camera list, each camera's status, and the stream /
 * MJPEG sessions that serve them.
 *
 * A camera's `status` is what the dashboard shows:
 *   running  enabled; streams start on demand (or are kept warm, see keepWarm)
 *   stopped  switched off by an operator
 *   error    enabled, but a stream gave up after maxRestarts — lastError says why
 * A running camera whose stream is retrying carries `lastError` too, which the
 * panes show as a red dot with the reason as its tooltip.
 */

const fs = require('fs');
const { StreamSession } = require('./stream-session');
const { MjpegSession } = require('./mjpeg');
const { probe } = require('./probe');
const { normaliseCamera, ID_RE } = require('./config');
const { hostOf, clearAllSessions, clearMulticastMemory, probeHost } = require('./sources');

const PROBLEM_NAMES = ['', 'network', 'network-down', 'no-video', 'camera']; // by P.PROBLEM value

class CameraManager {
  constructor(store) {
    this.store = store;
    this.sessions = new Map();   // "id/label" -> StreamSession
    this.mjpegs = new Map();     // id -> MjpegSession
    this.variants = new Map();   // "id/label" -> probe / init info
    this.state = new Map();      // id -> { status, lastError }
    this.processes = new Set();
    this.protectedPids = new Set(); // recordings: never reaped as strays
    this.hub = null;             // set by index.js
    this._probing = new Set();
  }

  /* --- lookup ------------------------------------------------------------- */

  get cameras() { return this.store.cameras; }
  camera(id) { return this.cameras.find((c) => c.id === id) || null; }

  resolveLabel(cam, quality) {
    if (!cam || !cam.sources.length) return null;
    if (quality && cam.sources.some((s) => s.label === quality)) return quality;
    if (cam.sources.some((s) => s.label === 'main')) return 'main';
    return cam.sources[0].label;
  }

  thumbVariant(id) {
    const cam = this.camera(id);
    if (!cam) return null;
    return cam.sources.some((s) => s.label === 'sub') ? 'sub' : this.resolveLabel(cam);
  }

  session(id, quality) {
    const cam = this.camera(id);
    const label = this.resolveLabel(cam, quality);
    if (!label) return null;
    const key = `${id}/${label}`;
    let s = this.sessions.get(key);
    if (!s) { s = new StreamSession(this, id, label); this.sessions.set(key, s); }
    return s;
  }

  mjpeg(id) {
    let m = this.mjpegs.get(id);
    if (!m) { m = new MjpegSession(this, id); this.mjpegs.set(id, m); }
    return m;
  }

  keepWarm(id, label) {
    const cam = this.camera(id);
    if (!cam || !cam.enabled || this.status(id).status === 'error') return false;
    const mode = this.store.settings.ffmpeg.keepWarm;
    if (mode === 'all') return true;
    if (mode === 'sub') return label === this.thumbVariant(id);
    return false;
  }

  applyKeepWarm() {
    for (const cam of this.cameras) {
      if (!cam.enabled) continue;
      for (const src of cam.sources) {
        if (this.keepWarm(cam.id, src.label)) this.session(cam.id, src.label).ensureRunning();
      }
    }
  }

  /* --- status ------------------------------------------------------------- */

  status(id) {
    const cam = this.camera(id);
    let st = this.state.get(id);
    if (!st) { st = { status: cam && cam.enabled ? 'running' : 'stopped', lastError: null }; this.state.set(id, st); }
    if (cam && !cam.enabled) st.status = 'stopped';
    return st;
  }

  onSessionLive(s) {
    const st = this.status(s.cameraId);
    if (st.status !== 'stopped') st.status = 'running';
    st.lastError = null;
  }

  onSessionFailed(s, why) {
    const st = this.status(s.cameraId);
    st.status = 'error';
    st.lastError = why;
  }

  /**
   * One camera not answering is that camera; none answering is the network
   * (the PC's LAN cable out, a switch down).  Resolves true when no other
   * camera is playing and up to four other camera hosts don't answer a TCP
   * knock either.  Shared and cached for 10 s, so a wall full of waiting
   * streams asks once.
   */
  cameraNetworkDown(exceptId) {
    const now = Date.now();
    if (this._netCheck && now - this._netCheck.at < 10000) return this._netCheck.result;
    for (const s of this.sessions.values()) {
      if (s.cameraId !== exceptId && s.state === 'live' && now - s.lastVideoAt < 5000) return Promise.resolve(false);
    }
    const own = hostOf(this.camera(exceptId)?.sources[0]?.url);
    const urls = new Map();
    for (const cam of this.cameras) {
      if (!cam.enabled || cam.id === exceptId) continue;
      const url = cam.sources[0]?.url;
      const host = hostOf(url);
      if (!host || host === own || urls.has(host) || !/^(rtsps?|https?|rtmp):/i.test(url)) continue;
      urls.set(host, url);
      if (urls.size >= 4) break;
    }
    const result = urls.size === 0 ? Promise.resolve(false)
      : Promise.all([...urls.values()].map((u) => probeHost(u, 2000))).then((r) => r.every((x) => x === 'unreachable'));
    this._netCheck = { at: now, result };
    return result;
  }

  variantInfo(id, label) { return this.variants.get(`${id}/${label}`) || null; }

  updateVariant(id, label, info) {
    const key = `${id}/${label}`;
    this.variants.set(key, { ...(this.variants.get(key) || {}), ...info });
  }

  /** The camera list the dashboard and viewers poll — no credentials in it. */
  list() {
    return this.cameras.map((cam) => {
      const st = this.status(cam.id);
      let lastError = st.lastError;
      let problem = null;
      if (cam.enabled) {
        for (const src of cam.sources) {
          const s = this.sessions.get(`${cam.id}/${src.label}`);
          if (!s || !(s.state === 'backoff' || s.state === 'starting' || s.state === 'failed')) continue;
          if (!lastError && s.lastError) lastError = s.lastError;
          if (!problem && s.problem) problem = { kind: PROBLEM_NAMES[s.problem.kind], text: s.problem.text, since: new Date(s.problem.since).toISOString() };
        }
      }
      return {
        id: cam.id,
        name: cam.name,
        group: cam.group || '',
        status: st.status,
        lastError: lastError || null,
        // Why a watched stream has no picture: { kind: 'network' | 'network-down' |
        // 'no-video' | 'camera', text, since (ISO) }, or null.
        problem,
        sourceHost: hostOf(cam.sources[0]?.url),
        variants: cam.sources.map((src) => {
          const v = this.variantInfo(cam.id, src.label) || {};
          const sess = this.sessions.get(`${cam.id}/${src.label}`);
          const live = sess && sess.active && sess.state === 'live';
          return {
            label: src.label, type: src.type,
            videoCodec: v.videoCodec || null, width: v.width || null, height: v.height || null,
            fps: v.fps || null, audioCodec: v.audioCodec || null, transcode: !!src.transcode,
            // How the running stream arrives: 'multicast' | 'unicast'; null when not running.
            delivery: live ? (sess.active.multicast ? 'multicast' : 'unicast') : null,
          };
        }),
      };
    });
  }

  /* --- editing ------------------------------------------------------------ */

  add(input) {
    const cam = normaliseCamera(input);
    if (this.camera(cam.id)) throw Object.assign(new Error(`A camera with id '${cam.id}' already exists`), { status: 409 });
    this.cameras.push(cam);
    this.store.saveCameras();
    this.state.delete(cam.id);
    this.probeCamera(cam);
    this.applyKeepWarm();
    return cam;
  }

  update(id, input) {
    const existing = this.camera(id);
    if (!existing) throw Object.assign(new Error(`No camera '${id}'`), { status: 404 });
    const merged = normaliseCamera({ ...existing, ...input, id, enabled: input.enabled ?? existing.enabled });
    const sourcesChanged = JSON.stringify(existing.sources) !== JSON.stringify(merged.sources);
    Object.assign(existing, merged);
    this.store.saveCameras();
    if (sourcesChanged) {
      this._teardownCamera(id, true);
      clearMulticastMemory(`${id}/`);
      for (const k of [...this.variants.keys()]) if (k.startsWith(id + '/')) this.variants.delete(k);
      this.probeCamera(existing);
    }
    return existing;
  }

  remove(id) {
    const i = this.cameras.findIndex((c) => c.id === id);
    if (i < 0) throw Object.assign(new Error(`No camera '${id}'`), { status: 404 });
    this._teardownCamera(id, true);
    this.cameras.splice(i, 1);
    this.state.delete(id);
    this.store.saveCameras();
  }

  /** Drop every session of a camera; its viewers are told to reconnect. */
  _teardownCamera(id, kick) {
    for (const [k, s] of [...this.sessions]) {
      if (!k.startsWith(id + '/')) continue;
      if (kick) s.kickAll(1012, 'camera changed');
      s.destroy();
      this.sessions.delete(k);
    }
    const m = this.mjpegs.get(id);
    if (m) {
      if (kick) for (const c of m.clients) c.close(1012, 'camera changed');
      m.destroy();
      this.mjpegs.delete(id);
    }
  }

  control(id, action) {
    const cam = this.camera(id);
    if (!cam) throw Object.assign(new Error(`No camera '${id}'`), { status: 404 });
    if (action === 'start') {
      cam.enabled = true;
      this.state.set(id, { status: 'running', lastError: null });
      this.store.saveCameras();
      this.applyKeepWarm();
    } else if (action === 'stop') {
      cam.enabled = false;
      this.store.saveCameras();
      this._teardownCamera(id, true);
      this.state.set(id, { status: 'stopped', lastError: null });
    } else if (action === 'restart') {
      cam.enabled = true;
      this.store.saveCameras();
      this._teardownCamera(id, true);
      this.state.set(id, { status: 'running', lastError: null });
      this.applyKeepWarm();
    } else {
      throw Object.assign(new Error(`Unknown action '${action}'`), { status: 400 });
    }
    return { ok: true, id, status: this.status(id).status };
  }

  /** Recycle Cameras: every FFmpeg ends, every viewer reconnects. */
  recycle() {
    const processes = this.processes.size;
    const cameras = new Set([...this.sessions.values()].map((s) => s.cameraId)).size;
    for (const id of new Set([...this.sessions.values()].map((s) => s.cameraId).concat([...this.mjpegs.keys()]))) {
      this._teardownCamera(id, false);
    }
    const strays = this.killStrays(true);
    const viewers = this.hub ? this.hub.closeAll(1012, 'recycle') : 0;
    clearAllSessions();
    clearMulticastMemory(); // a recycle retries multicast where it fell back
    for (const cam of this.cameras) if (cam.enabled) this.state.set(cam.id, { status: 'running', lastError: null });
    setTimeout(() => this.applyKeepWarm(), 500);
    return { cameras, processes, strays, viewers };
  }

  /* --- processes ------------------------------------------------------------ */

  trackProcess(p) { this.processes.add(p); }
  untrackProcess(p) { this.processes.delete(p); }

  /**
   * FFmpeg children of this process that nothing is tracking any more.
   * `includeTracked` (Recycle only) also kills the tracked ones that were
   * told to stop but have not exited yet.
   */
  killStrays(includeTracked = false) {
    let n = 0;
    const known = new Set([...this.processes].map((p) => p.pid));
    let entries = [];
    try { entries = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return 0; }
    for (const pid of entries) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const m = /^\d+ \((.*)\) \S+ (\d+)/.exec(stat);
        if (!m || !/ffmpeg|ffprobe/.test(m[1]) || Number(m[2]) !== process.pid) continue;
        if (this.protectedPids.has(Number(pid))) continue;
        if (known.has(Number(pid))) {
          if (includeTracked) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } }
          continue;
        }
        process.kill(Number(pid), 'SIGKILL');
        n++;
      } catch { /* raced */ }
    }
    return n;
  }

  ffmpegMemory() {
    let total = 0;
    for (const p of this.processes) {
      try {
        const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${p.pid}/status`, 'utf8'));
        if (m) total += Number(m[1]) * 1024;
      } catch { /* exited */ }
    }
    return total;
  }

  /* --- probing -------------------------------------------------------------- */

  async probeCamera(cam) {
    for (const src of cam.sources) {
      const key = `${cam.id}/${src.label}`;
      if (this._probing.has(key)) continue;
      this._probing.add(key);
      try {
        const r = await probe(src, this.store.settings, { key });
        if (r.ok) this.updateVariant(cam.id, src.label, { ...r, probedAt: Date.now() });
        else this.updateVariant(cam.id, src.label, { probeError: r.error, probedAt: Date.now() });
      } finally { this._probing.delete(key); }
    }
  }

  async probeAll() {
    const queue = this.cameras.filter((c) => c.enabled);
    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) {
        const cam = queue.shift();
        // Already known from a running stream: skip.
        if (cam.sources.every((s) => this.variantInfo(cam.id, s.label)?.videoCodec)) continue;
        await this.probeCamera(cam).catch(() => {});
      }
    });
    await Promise.all(workers);
  }

  stats() {
    const sessions = [...this.sessions.values()];
    return {
      activeStreams: sessions.filter((s) => s.active && !s.active.exited).length,
      sessions: sessions.map((s) => s.info()),
      mjpeg: [...this.mjpegs.values()].map((m) => m.info()),
      processes: this.processes.size,
    };
  }

  shutdown() {
    for (const s of this.sessions.values()) s.destroy();
    for (const m of this.mjpegs.values()) m.destroy();
    for (const p of this.processes) try { p.kill('SIGKILL'); } catch { /* gone */ }
  }
}

module.exports = { CameraManager, ID_RE };
