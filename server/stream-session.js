'use strict';
/**
 * StreamSession — one camera variant (e.g. "lobby / sub"), its FFmpeg
 * pipeline, and everyone watching it.
 *
 * PIPELINE
 *   One FFmpeg per variant, with up to three outputs on separate pipes so no
 *   output's muxer ever waits on another's (cross-stream interleaving in a
 *   single muxer is the classic hidden source of live latency):
 *
 *     pipe:1  video   fragmented MP4, one fragment per frame, codec COPIED
 *             (H.264/HEVC passthrough — no transcode, no added latency)
 *     pipe:3  audio   fragmented MP4, Opus 48 kHz, 20 ms packets, lowdelay
 *     pipe:4  audio   raw G.711 mu-law 16 kHz mono, for browsers that have
 *             VideoDecoder but no AudioDecoder (Safari before 26 — which
 *             includes every iPad 6th gen, whose last OS is iPadOS 17)
 *
 *   Timestamps are re-based onto this server's monotonic clock the first time
 *   each pipeline produces a sample.  That keeps them continuous across
 *   pipeline restarts and recycles, which is what lets a recycle swap
 *   pipelines under a live viewer without the playout clock jumping.
 *
 * VIEWERS
 *   A late joiner is sent the cached GOP (everything since the last keyframe)
 *   flagged as catch-up, so its first picture is immediate and the client can
 *   anchor on the newest frame — joining at the live edge, not a GOP behind.
 *
 *   Backpressure is per viewer and GOP-aware: past SOFT_CAP of unsent bytes a
 *   viewer stops receiving video until the next keyframe (so its decoder never
 *   sees a GOP with holes); past HARD_CAP it is closed with 1013, which tells
 *   the client to drop to the substream before it reconnects.
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { Fmp4Parser, inbandParamSets, buildHvcc, replaceHvcc, hevcCodecString } = require('./fmp4');
const P = require('./protocol');
const {
  inputArgs, friendlyError, redact, clearSession, noteMulticast, clearMulticastMemory, wantsMulticast, MULTICAST_RETRY_MS, probeHost,
} = require('./sources');

const SOFT_CAP = 1.5 * 1024 * 1024;
const HARD_CAP = 8 * 1024 * 1024;
const GOP_MAX_BYTES = 24 * 1024 * 1024;
const GOP_MAX_FRAMES = 900;
const PCM_RATE = 16000;
const PCM_FRAME_BYTES = 640; // 40 ms of 16 kHz mu-law

const nowUs = () => Number(process.hrtime.bigint() / 1000n);

const FMP4_FLAGS = ['-f', 'mp4', '-movflags', 'empty_moov+default_base_moof+frag_every_frame+skip_trailer',
  '-flush_packets', '1', '-muxdelay', '0', '-muxpreload', '0'];

class Pipeline extends EventEmitter {
  constructor(session, opts) {
    super();
    this.session = session;
    this.withAudio = opts.withAudio;
    this.proc = null;
    this.startedAt = Date.now();
    this.stderrTail = '';
    this.videoOffset = null;
    this.audioOffset = null;
    this.pcmOffset = null;
    this.pcmBuf = Buffer.alloc(0);
    this.pcmSentFrames = 0;
    this.exited = false;
  }

  async start() {
    const s = this.session;
    const settings = s.manager.store.settings;
    const src = s.source;
    const input = await inputArgs(src, settings, {
      key: `${s.cameraId}/${s.label}`,
      slowProbe: s.slowProbe,
      forceTcp: s.forceTcp,
      multicast: Date.now() < s.noMulticastUntil ? false : undefined,
      log: (m) => s.log(m),
    });
    this.multicast = !!input.multicast;
    const probed = s.manager.variantInfo(s.cameraId, s.label);
    const transcode = src.transcode || input.needsEncode
      || (probed && probed.videoCodec && !['h264', 'hevc'].includes(probed.videoCodec));
    const fps = (probed && probed.fps) || 25;
    const videoCodec = transcode
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high',
        '-pix_fmt', 'yuv420p', '-g', String(Math.round(fps * 2)), '-bf', '0']
      : ['-c:v', 'copy'];
    // hev1 keeps the in-band VPS/SPS/PPS that hvc1 strips; see _onVideoInit.
    if (!transcode && probed && probed.videoCodec === 'hevc') videoCodec.push('-tag:v', s.hevcInband ? 'hev1' : 'hvc1');

    const wc = settings.webcodecs;
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'warning', ...input.args,
      '-map', input.video, '-an', '-sn', '-dn', ...videoCodec, ...FMP4_FLAGS, 'pipe:1'];
    if (this.withAudio) {
      args.push('-map', input.audio, '-vn', '-sn', '-dn', '-c:a', 'libopus', '-b:a', String(wc.audioBitrate || '64k'),
        '-ac', String(wc.audioChannels || 1), '-ar', '48000', '-application', 'lowdelay', '-frame_duration', '20',
        ...FMP4_FLAGS, 'pipe:3');
      args.push('-map', input.audio, '-vn', '-sn', '-dn', '-c:a', 'pcm_mulaw', '-ar', String(PCM_RATE), '-ac', '1',
        '-f', 'mulaw', '-flush_packets', '1', 'pipe:4');
    }
    s.log(`spawn ${redact(this.multicast ? (src.multicastUrl || src.url) : src.url)}${this.multicast ? ' (multicast)' : ''}${transcode ? ' (transcode h264)' : ''}${this.withAudio ? '' : ' (no audio)'}`);

    const proc = spawn(settings.ffmpeg.path || 'ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    s.manager.trackProcess(proc);

    const vp = new Fmp4Parser();
    vp.on('init', (init) => {
      const track = [...init.tracks.values()].find((t) => t.kind === 'video');
      if (track) this._onVideoInit(track, init.raw);
    });
    vp.on('fragment', (f) => {
      const nu = nowUs();
      let first = true;
      for (const smp of f.samples) {
        if (smp.kind !== 'video') continue;
        let data = smp.data;
        if (this.inbandInit) {
          data = this._inbandSample(smp);
          if (!data) continue;
        }
        if (this.videoOffset === null) this.videoOffset = nu - smp.ptsUs;
        this.emit('video-sample', smp.ptsUs + this.videoOffset, smp.isKey, data, first ? f : null);
        first = false;
      }
    });
    vp.on('error', (e) => { s.log(`video parse: ${e.message}`); this.kill(); });
    proc.stdio[1].on('data', (c) => vp.push(c));

    if (this.withAudio) {
      const ap = new Fmp4Parser();
      ap.on('init', (init) => {
        const t = [...init.tracks.values()].find((x) => x.kind === 'audio');
        if (t) this.emit('audio-init', t);
      });
      ap.on('fragment', (f) => {
        const nu = nowUs();
        for (const smp of f.samples) {
          if (smp.kind !== 'audio') continue;
          if (this.audioOffset === null) this.audioOffset = nu - smp.ptsUs;
          this.emit('audio-sample', smp.ptsUs + this.audioOffset, smp.data);
        }
      });
      ap.on('error', (e) => s.log(`audio parse: ${e.message}`));
      proc.stdio[3].on('data', (c) => ap.push(c));
      proc.stdio[4].on('data', (c) => this._onPcm(c));
    }

    proc.stdio[2].on('data', (d) => {
      const text = d.toString();
      this.stderrTail = (this.stderrTail + text).slice(-4000);
      const gaps = (text.match(/RTP: missed \d+ packets/g) || []).length;
      if (gaps) s._onRtpLoss(this, gaps);
    });
    proc.on('error', (err) => { this.stderrTail += `\nspawn ${err.code || ''} ${err.message}`; });
    proc.on('close', (code, signal) => {
      this.exited = true;
      s.manager.untrackProcess(proc);
      this.emit('exit', code, signal, this.stderrTail);
    });
  }

  /**
   * An H.265 stream whose SDP has no VPS (seen on Uniview cameras) gets an
   * hvcC no decoder accepts.  Tagged hvc1, FFmpeg also strips the VPS the
   * camera sends in-band, so restart as hev1; as hev1, wait for the first
   * keyframe and build the hvcC from its own VPS/SPS/PPS.
   */
  _onVideoInit(track, raw) {
    if (track.codec !== 'hevc' || track.complete) { this.emit('video-init', track, raw); return; }
    if (track.format !== 'hev1') {
      this.session.hevcInband = true;
      this.needsRestart = true;
      this.session.log('H.265 without a VPS in the SDP — restarting with the in-band parameter sets kept');
      this.kill();
      return;
    }
    this.inbandInit = { track, raw };
  }

  /** A sample of an in-band-parameter-set stream, with the sets moved into the hvcC; null to drop it. */
  _inbandSample(smp) {
    if (!smp.isKey) return this.hevcRecord ? smp.data : null;
    const ps = inbandParamSets(smp.data);
    if (!ps) return this.hevcRecord ? smp.data : null;
    let rec;
    try { rec = buildHvcc(ps.vps, ps.sps, ps.pps); } catch (err) {
      this.session.log(`in-band parameter sets unreadable: ${err.message}`);
      return this.hevcRecord ? ps.rest : null;
    }
    if (!this.hevcRecord || !rec.equals(this.hevcRecord)) {
      this.hevcRecord = rec;
      const { track, raw } = this.inbandInit;
      this.emit('video-init', { ...track, record: rec, complete: true, codecString: hevcCodecString(rec) }, replaceHvcc(raw, rec));
    }
    return ps.rest;
  }

  _onPcm(chunk) {
    this.pcmBuf = this.pcmBuf.length ? Buffer.concat([this.pcmBuf, chunk]) : chunk;
    while (this.pcmBuf.length >= PCM_FRAME_BYTES) {
      const frame = this.pcmBuf.subarray(0, PCM_FRAME_BYTES);
      this.pcmBuf = this.pcmBuf.subarray(PCM_FRAME_BYTES);
      if (this.pcmOffset === null) this.pcmOffset = nowUs();
      const pts = this.pcmOffset + (this.pcmSentFrames * PCM_FRAME_BYTES * 1e6) / PCM_RATE;
      this.pcmSentFrames++;
      this.emit('pcm', pts, Buffer.from(frame));
    }
  }

  kill() {
    if (!this.proc || this.exited) return;
    try { this.proc.kill('SIGTERM'); } catch { /* gone */ }
    const p = this.proc;
    setTimeout(() => { if (!this.exited) try { p.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref();
  }
}

class StreamSession {
  constructor(manager, cameraId, label) {
    this.manager = manager;
    this.cameraId = cameraId;
    this.label = label;
    this.clients = new Set();       // viewer sockets (see ws-server.js)
    this.rawConsumers = new Set();  // internal consumers of raw fMP4 (MJPEG)
    this.active = null;
    this.pending = null;            // recycle replacement, warming up
    this.state = 'idle';            // idle | starting | live | backoff | failed | stopped
    this.lastError = null;
    this.audioAvailable = null;     // null = unknown; false once a pipeline proved there is none
    this.slowProbe = false;
    this.forceTcp = false;          // set when an RTSP/UDP source never produced a picture
    this.noMulticastUntil = 0;      // set when multicast gave no picture or kept stalling
    this.multicastStalls = [];      // stall times while on multicast (see _onExit)
    this.problem = null;            // { kind, text, since }: why viewers have no picture (P.PROBLEM)
    this.lostAt = 0;                // when the picture was lost (or the first start failed); 0 while fine
    this._retryGen = 0;             // bumped per failure, so a stale reachability answer is dropped

    this.track = null;
    this.videoConfigMsg = null;
    this.audioTrack = null;
    this.audioConfigMsg = null;
    this.initRaw = null;
    this.gop = [];
    this.gopRaw = [];
    this.gopBytes = 0;
    this.gopOverflow = false;

    this.restarts = [];
    this.restartTimer = null;
    this.idleTimer = null;
    this.lastVideoAt = 0;
    this.liveSince = 0;
    this.stats = { bytesIn: 0, bytesOut: 0, frames: 0, skips: 0, kicks: 0, restarts: 0, recycles: 0, rtpGaps: 0, lossHolds: 0, lossHeld: 0, keyRequests: 0 };
    this.multicastLoss = [];        // times of recent RTP gaps while on multicast (_onMulticastLoss)
    this._bpsSample = { at: Date.now(), bytes: 0, inBytes: 0, frames: 0, bps: 0, inBps: 0, fps: 0 };
    this.ptsLagMs = null;
    this.watchdog = setInterval(() => this._watchdog(), 2000);
    this.watchdog.unref();
  }

  get source() {
    const cam = this.manager.camera(this.cameraId);
    return cam && cam.sources.find((s) => s.label === this.label);
  }

  log(msg) { console.log(`[stream ${this.cameraId}/${this.label}] ${msg}`); }

  get consumerCount() { return this.clients.size + this.rawConsumers.size; }

  /* --- Lifecycle --------------------------------------------------------- */

  ensureRunning() {
    clearTimeout(this.idleTimer); this.idleTimer = null;
    if (this.state === 'idle' || this.state === 'stopped' || this.state === 'failed') {
      this.restarts = [];
      this._spawn();
    }
  }

  _spawn() {
    clearTimeout(this.restartTimer); this.restartTimer = null;
    if (!this.source) { this.state = 'stopped'; return; }
    this.state = 'starting';
    this._startedAt = Date.now();
    const withAudio = this.audioAvailable !== false && this.manager.variantInfo(this.cameraId, this.label)?.hasAudio !== false;
    const p = new Pipeline(this, { withAudio });
    this.active = p;
    this._bind(p);
    p.start().catch((err) => {
      this.lastError = err.message;
      this.log(`start failed: ${err.message}`);
      if (err.auth) clearSession(`${this.cameraId}/${this.label}`);
      p.exited = true;
      this._onExit(p, 1, null, err.message);
    });
    // FFmpeg takes up to 25 s to give up on a camera that isn't there.  A
    // TCP knock on its port answers in at most 3, so an unplugged camera or
    // a dead network shows as such right away.
    probeHost(this.source.url, 3000).then((h) => {
      if (h === 'unreachable' && p === this.active && this.state === 'starting' && !p.exited) {
        p.stderrTail += '\nNo route to host';
        p.kill();
      }
    });
  }

  _bind(p) {
    p.on('video-init', (track, raw) => this._onVideoInit(p, track, raw));
    p.on('video-sample', (pts, isKey, data, frag) => this._onVideoSample(p, pts, isKey, data, frag));
    p.on('audio-init', (t) => { if (p === this.active) this._onAudioInit(t); else p._pendingAudio = t; });
    p.on('audio-sample', (pts, data) => { if (p === this.active) this._onAudioSample(pts, data); });
    p.on('pcm', (pts, data) => { if (p === this.active) this._onPcm(pts, data); });
    p.on('exit', (code, signal, tail) => this._onExit(p, code, signal, tail));
  }

  /** Viewer-visible shutdown: no consumers left and the linger expired, or the camera was stopped. */
  stop(reason = 'idle') {
    clearTimeout(this.restartTimer); this.restartTimer = null;
    clearTimeout(this.idleTimer); this.idleTimer = null;
    this.state = reason === 'failed' ? 'failed' : (reason === 'stopped' ? 'stopped' : 'idle');
    for (const p of [this.active, this.pending]) if (p) { p.removeAllListeners(); p.kill(); }
    this.active = null; this.pending = null;
    // Nobody is watching any more: the next viewer finds out afresh (the
    // camera may well have come back meanwhile, unseen).
    if (reason !== 'failed') { this.problem = null; this.lostAt = 0; }
    this._resetCaches();
  }

  destroy() {
    clearInterval(this.watchdog);
    this.stop('stopped');
    for (const c of this.clients) c.detach?.();
    this.clients.clear();
    for (const r of this.rawConsumers) r.onReset?.();
    this.rawConsumers.clear();
  }

  _resetCaches() {
    this.track = null; this.videoConfigMsg = null; this.audioTrack = null; this.audioConfigMsg = null;
    this.initRaw = null; this.gop = []; this.gopRaw = []; this.gopBytes = 0; this.gopOverflow = false;
    this.liveSince = 0;
  }

  _scheduleIdle() {
    if (this.consumerCount > 0 || this.manager.keepWarm(this.cameraId, this.label)) return;
    clearTimeout(this.idleTimer);
    const ms = this.manager.store.settings.ffmpeg.idleTimeoutMs ?? 30000;
    this.idleTimer = setTimeout(() => {
      if (this.consumerCount === 0 && !this.manager.keepWarm(this.cameraId, this.label)) {
        this.log('idle — stopping');
        this.stop('idle');
      }
    }, ms);
  }

  _onExit(p, code, signal, tail) {
    if (p === this.pending) {
      this.pending = null;
      this.log('recycle replacement exited before taking over');
      // A multicast retry that never got going: stay on unicast for a while.
      if (p.multicast) {
        this.noMulticastUntil = Date.now() + MULTICAST_RETRY_MS;
        noteMulticast(`${this.cameraId}/${this.label}`, false);
        this.log('multicast retry got no picture — staying on unicast');
      }
      return;
    }
    if (p !== this.active) return;
    this.active = null;
    if (this.state === 'idle' || this.state === 'stopped' || this.state === 'failed') return;
    if (p.needsRestart) { this._spawn(); return; }  // H.265 switching to hev1 (Pipeline._onVideoInit)

    const why = friendlyError(tail) || (tail ? tail.trim().split('\n').pop() : null) || `FFmpeg exited (${signal || code})`;
    // No audio stream: retry immediately without the audio outputs.
    if (p.withAudio && /matches no streams|does not contain any stream/i.test(tail || '') && this.liveSince === 0) {
      this.audioAvailable = false;
      this.log('no audio track — restarting video only');
      this._spawn();
      return;
    }
    // Stream parameters were not found inside the short probe window
    // (typically a long keyframe interval, or H.265 whose VPS only comes with
    // the keyframe): retry once with a long probe.  Checked before multicast:
    // packets did arrive, so multicast isn't what failed.
    if (!this.slowProbe && this.liveSince === 0
        && /dimensions not set|unspecified size|Could not find codec parameters|codec frame size is not set/i.test(tail || '')) {
      this.slowProbe = true;
      this.log('stream parameters not found in a short probe — retrying with a long one');
      this._spawn();
      return;
    }
    // Multicast that never produced a picture: the group isn't reaching this
    // container (Docker Desktop, a bridged network, a router that doesn't
    // forward it).  Fall back to unicast TCP, and let the next starts of this
    // stream skip multicast for a while (sources.js).
    // Only if the camera itself answers, though: when it is unplugged or the
    // network is down every transport fails alike, and blaming multicast
    // would keep this stream off it for an hour after the network returns.
    if (p.multicast && this.liveSince === 0 && !/rejected the username/.test(why)) {
      probeHost(this.source.multicastUrl || this.source.url).then((h) => {
        // Stopped, or started again some other way, while we were checking.
        if (this.active || this.pending || ['idle', 'stopped', 'failed'].includes(this.state)) return;
        if (h !== 'ok') {
          this._retryOrFail(h === 'refused' ? friendlyError('Connection refused') : 'The camera cannot be reached on the network', h);
          return;
        }
        this.noMulticastUntil = Date.now() + MULTICAST_RETRY_MS;
        noteMulticast(`${this.cameraId}/${this.label}`, false);
        this.log('no picture over multicast — switching this stream to unicast');
        this._spawn();
      });
      return;
    }
    // Multicast that plays, then stalls, then plays again after a rejoin is
    // the classic sign of a switch with IGMP snooping and no IGMP querier: it
    // prunes the group a few minutes after each join.  Twice in 15 minutes and
    // this stream goes back to TCP.
    // Not for a source set to keep multicast: the restart below rejoins the group.
    if (p.multicast && this.liveSince > 0 && /stopped sending video/.test(tail || '') && !this.source.keepMulticast) {
      const now = Date.now();
      this.multicastStalls = this.multicastStalls.filter((t) => now - t < 15 * 60 * 1000);
      this.multicastStalls.push(now);
      if (this.multicastStalls.length >= 2) {
        this.noMulticastUntil = now + MULTICAST_RETRY_MS;
        this.multicastStalls = [];
        noteMulticast(`${this.cameraId}/${this.label}`, false);
        this.log('multicast keeps stalling (no IGMP querier on the network?) — switching this stream to unicast');
      }
    }
    // RTSP over UDP that never produced a picture: almost always the return
    // path being blocked (Docker's bridged network, a firewall).  Retry the
    // same camera over TCP — every camera that does RTSP does TCP.
    // (Not when the camera isn't there at all: that says nothing about UDP.)
    if (!this.forceTcp && this.liveSince === 0 && this.source && this.source.type === 'rtsp' && this.source.transport === 'udp'
        && !/cannot be reached/.test(why)) {
      this.forceTcp = true;
      this.log('no picture over UDP — switching this stream to TCP');
      this._spawn();
      return;
    }
    this._retryOrFail(why);
  }

  /**
   * After a pipeline exit no special case handled: back off and retry, or
   * give up.  `host` is what a TCP knock on the camera already said, when
   * the caller knocked (see probeHost); otherwise it is asked here.
   */
  _retryOrFail(why, host) {
    this.lastError = why;
    if (/rejected the username/.test(why)) clearSession(`${this.cameraId}/${this.label}`);
    this.log(`exited: ${why}`);
    this._broadcast(P.streamReset(), true);
    for (const c of this.clients) c.configSent = false;
    for (const r of this.rawConsumers) r.onReset?.();
    const hadPicture = this.liveSince > 0;
    if (!this.lostAt) this.lostAt = hadPicture && this.lastVideoAt ? this.lastVideoAt : Date.now();
    this._resetCaches();

    if (this.consumerCount === 0 && !this.manager.keepWarm(this.cameraId, this.label)) { this.state = 'idle'; return; }

    // Is the camera there at all?  A camera that doesn't answer on the
    // network is waited for (_waitForCamera), not retried: every transport
    // fails alike until it is back, and the viewer should be told so.
    this.state = 'backoff';
    const gen = ++this._retryGen;
    const knock = host !== undefined ? Promise.resolve(host) : probeHost(this.source && this.source.url);
    knock.then((h) => {
      if (gen !== this._retryGen || this.state !== 'backoff' || this.active) return;
      if (h === 'unreachable') { this._waitForCamera(gen); return; }
      if (h === 'refused' && !/refused/.test(why)) why = this.lastError = friendlyError('Connection refused');
      this._backoff(why, hadPicture);
    });
  }

  _backoff(why, hadPicture) {
    // The camera answers on the network: either it sends nothing (a stall,
    // a timeout) or it said no (password, path, busy, a closed port).
    const kind = /did not answer in time|stopped sending video|could not read|FFmpeg exited/.test(why)
      ? P.PROBLEM.NO_VIDEO : P.PROBLEM.CAMERA;
    const settings = this.manager.store.settings.ffmpeg;
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < (settings.restartWindowMs || 300000));
    this.restarts.push(now);
    this.stats.restarts++;
    if (this.restarts.length > (settings.maxRestarts || 10)) {
      this.log(`giving up after ${this.restarts.length - 1} restarts`);
      this._broadcast(P.streamError(why), true);
      this._setProblem(kind, why, true);
      this.stop('failed');
      this.manager.onSessionFailed(this, why);
      return;
    }
    this._broadcast(P.streamError(why), true);
    this._setProblem(kind, why, true);
    // A stream that was playing gets a quick first retry; one that never
    // started backs off at the configured delay (doubling to 30 s).
    const n = this.restarts.length;
    const delay = hadPicture && n === 1 ? 500 : Math.min(30000, (settings.restartDelayMs || 5000) * Math.pow(1.5, n - 1));
    this.restartTimer = setTimeout(() => this._spawn(), delay);
  }

  /**
   * The camera doesn't answer on the network (unplugged, powered off, or the
   * network itself is down).  Instead of an FFmpeg every 30 s, knock on its
   * port every few seconds and start the moment it answers.  Not counted as
   * restarts: this never gives up while someone is watching, and recovery
   * takes seconds, not a backoff step.
   */
  _waitForCamera(gen) {
    const text = 'The camera cannot be reached on the network';
    this.lastError = text;
    this.log('the camera does not answer on the network — waiting for it');
    this._broadcast(P.streamError(text), true);
    const live = () => gen === this._retryGen && this.state === 'backoff' && !this.active;
    let first = true;
    const round = async () => {
      // One camera gone, or all of them?  The answer changes the message,
      // and can change while we wait (the other cameras drop one by one).
      const down = await this.manager.cameraNetworkDown(this.cameraId);
      if (!live()) return;
      if (down) this._setProblem(P.PROBLEM.NETWORK_DOWN, 'No camera can be reached — the camera network looks down', first);
      else this._setProblem(P.PROBLEM.NETWORK, text, first);
      first = false;
      this.restartTimer = setTimeout(async () => {
        const h = await probeHost(this.source && this.source.url);
        if (!live()) return;
        if (h === 'unreachable') { round(); return; }
        this.log('the camera answers again — restarting');
        this.restarts = [];
        this._spawn();
      }, 5000);
    };
    round();
  }

  /**
   * Tell viewers (and the thumbnail tier) why there is no picture.  Sent
   * again after every failed start (`force`): a restart that got as far as
   * the camera's stream header has told the clients 'streaming' meanwhile.
   */
  _setProblem(kind, text, force) {
    const p = this.problem;
    if (!force && p && p.kind === kind && p.text === text) return;
    this.problem = { kind, text, since: this.lostAt || Date.now() };
    this._broadcast(P.streamProblem(kind, this.problem.since, text), true);
    for (const r of this.rawConsumers) r.onProblem?.(this.problem);
  }

  _clearProblem() {
    this.lostAt = 0;
    if (!this.problem) return;
    this.problem = null;
    this._broadcast(P.streamProblem(P.PROBLEM.CLEAR, 0, ''), true);
    for (const r of this.rawConsumers) r.onProblem?.(null);
  }

  _watchdog() {
    const p = this.active;
    if (!p || p.exited) return;
    const ff = this.manager.store.settings.ffmpeg;
    const now = Date.now();
    const udpTry = p.multicast || (this.source && this.source.transport === 'udp' && !this.forceTcp);
    if (this.state === 'starting' && now - this._startedAt > (udpTry ? 8000 : 25000)) {
      this.log(`no picture within ${udpTry ? 8 : 25} s — restarting`);
      p.stderrTail += '\nOperation timed out';
      p.kill();
    } else if (this.state === 'live' && now - this.lastVideoAt > (ff.stallTimeoutMs || 10000)) {
      this.log('stalled — restarting');
      p.stderrTail += '\nThe camera stopped sending video';
      p.kill();
    } else if (this.state === 'live' && ff.recycleAfterMs > 0 && !this.pending
               && now - p.startedAt > ff.recycleAfterMs) {
      this._recycle();
    }
    // bitrate / fps sample
    const s = this._bpsSample, dt = (now - s.at) / 1000;
    if (dt >= 2) {
      s.bps = (this.stats.bytesOut - s.bytes) / dt; s.fps = (this.stats.frames - s.frames) / dt;
      s.inBps = (this.stats.bytesIn - s.inBytes) / dt;
      s.at = now; s.bytes = this.stats.bytesOut; s.inBytes = this.stats.bytesIn; s.frames = this.stats.frames;
    }
  }

  /** Whether this stream's source is set to use multicast (it may still be on unicast after a fallback). */
  get multicastWanted() {
    return !!this.source && wantsMulticast(this.source, this.manager.store.settings);
  }

  /**
   * Back onto multicast after a fallback, once the network has been fixed:
   * forget the fallback and, if the stream is running over unicast, swap
   * pipelines make-before-break so viewers see no gap.  If multicast still
   * gets no picture the replacement never takes over and the stream stays
   * on unicast; if it still loses packets, _onMulticastLoss moves it back.
   * Returns whether there was anything to retry.
   */
  retryMulticast() {
    if (!this.multicastWanted) return false;
    this.noMulticastUntil = 0;
    this.multicastStalls = [];
    this.multicastLoss = [];
    clearMulticastMemory(`${this.cameraId}/${this.label}`);
    if (this.state === 'live' && this.active && !this.active.multicast && !this.pending) {
      this.log('retrying multicast (make-before-break)');
      this._recycle();
    }
    return true;
  }

  /**
   * RTP over UDP (multicast, or RTSP set to UDP) lost packets on the way.
   * FFmpeg only warns and passes the damaged frame on, and with the video
   * copied the browser decodes it: green blocks and smears that every later
   * frame builds on until the next keyframe.  So, unless settings.ffmpeg.
   * holdOnLoss is false, this pipeline's frames are held back from the next
   * one FFmpeg puts out to the next keyframe that wasn't itself damaged
   * (_holdAfterLoss): viewers see the last good picture freeze instead.
   * FFmpeg prints the warning before it puts out the frame the packet
   * belonged to, so no damaged frame slips through ahead of it.
   */
  _onRtpLoss(p, gaps) {
    this.stats.rtpGaps += gaps;
    if (this.manager.store.settings.ffmpeg.holdOnLoss !== false) {
      if (!p.lossHold) { p.lossHold = Date.now(); this.stats.lossHolds++; }
      p.lossFresh = true;
    }
    if (this.manager.store.settings.ffmpeg.keyframeOnLoss !== false) this._requestKeyframe(p);
    if (p.multicast) this._onMulticastLoss(p, gaps);
  }

  /**
   * Ask the camera for a keyframe now, so the picture held after a loss (or
   * smeared, with holdOnLoss off) is whole again in a fraction of a second
   * instead of at the camera's next keyframe.  Only while somebody is
   * watching: nobody sees an unwatched stream's freezes, and the camera is
   * spared the requests.  A camera that cannot do it is left alone (onvif.js).
   * A request that had to wait its turn is dropped if `p`'s picture is no
   * longer held by then (with holdOnLoss off there is no telling: it goes out).
   */
  _requestKeyframe(p) {
    const kf = this.manager.keyframes;
    const src = this.source;
    if (!kf || !src || !this.consumerCount) return;
    const needed = () => this.consumerCount > 0 && p === this.active
      && (!!p.lossHold || this.manager.store.settings.ffmpeg.holdOnLoss === false);
    kf.request(this.manager.camera(this.cameraId), src, { needed }).then((r) => {
      if (r === 'sent') this.stats.keyRequests++;
      else if (r === 'failed') this.log(`no keyframe on request: ${kf.error(this.cameraId, this.label)}`);
    });
  }

  /**
   * Whether a sample of `p` is held back after a loss.  FFmpeg queues the
   * packets behind a gap until it gives up on the missing one, then puts
   * out every frame they make at once: the damaged frame is somewhere in
   * that burst, and an older good one may come first (FFmpeg reads and
   * writes in separate threads).  So a keyframe in the burst (frames less
   * than 20 ms apart, starting with the first one after the warning) is
   * held too; on cam-31 such keyframes came out 2-18 KB short.  A stream
   * losing packets in every keyframe would never show a picture: after 5 s
   * the hold gives up and the frames go out as they are.
   */
  _holdAfterLoss(p, isKey) {
    const now = Date.now();
    const burst = p.lossFresh || (p.lossBurst && now - p.lossLastAt < 20);
    p.lossFresh = false;
    p.lossBurst = burst;
    p.lossLastAt = now;
    if ((isKey && !burst) || now - p.lossHold > 5000) { p.lossHold = 0; return false; }
    this.stats.lossHeld++;
    return true;
  }

  /**
   * Multicast is plain UDP: a lost packet corrupts the picture until the
   * next keyframe (see _onRtpLoss).  Seen on the Uniview cameras, whose
   * groups lose packets on the way while every Dahua group arrives whole.  A
   * stream that loses packets three times in a minute moves to unicast TCP
   * for a while, make-before-break, so viewers see no gap.  Not a source set
   * to keep multicast (cameras that struggle with more unicast streams): it
   * only counts the gaps, and the held frames hide them.
   */
  _onMulticastLoss(p, gaps) {
    if (p !== this.active || this.pending || this.source.keepMulticast) return;
    const now = Date.now();
    this.multicastLoss = this.multicastLoss.filter((t) => now - t < 60000);
    for (let i = 0; i < gaps; i++) this.multicastLoss.push(now);
    if (this.multicastLoss.length < 3) return;
    this.multicastLoss = [];
    this.noMulticastUntil = now + MULTICAST_RETRY_MS;
    noteMulticast(`${this.cameraId}/${this.label}`, false);
    this.log('multicast is losing packets (3 gaps in a minute) — switching this stream to unicast');
    this._recycle();
  }

  /** Make-before-break: warm a replacement, switch at its first keyframe. */
  _recycle() {
    this.log('recycling pipeline (make-before-break)');
    this.stats.recycles++;
    const p = new Pipeline(this, { withAudio: this.active.withAudio });
    this.pending = p;
    this._bind(p);
    p.start().catch(() => { this.pending = null; });
  }

  /* --- Media ------------------------------------------------------------- */

  _onVideoInit(p, track, raw) {
    if (p === this.pending) { p._pendingInit = { track, raw }; return; }
    if (p !== this.active) return;
    this._applyVideoInit(track, raw);
  }

  _applyVideoInit(track, raw) {
    const same = this.track && this.track.codecString === track.codecString && this.track.record.equals(track.record);
    this.track = track;
    this.initRaw = raw;
    this.manager.updateVariant(this.cameraId, this.label, {
      videoCodec: track.codec, width: track.width, height: track.height, codecString: track.codecString,
    });
    if (!track.record) {
      this.lastError = `Unsupported video codec (${track.codec})`;
      this._broadcast(P.streamError(this.lastError), true);
      return;
    }
    this.videoConfigMsg = P.videoConfig(track.fourCC, track.codecString, track.record);
    if (!same) {
      for (const c of this.clients) { c.sendConfig(this); }
    }
    for (const r of this.rawConsumers) r.onInit?.(raw);
  }

  _onVideoSample(p, pts, isKey, data, frag) {
    if (p.lossHold && this._holdAfterLoss(p, isKey)) {
      // Still arriving, so not a stall for the watchdog.
      if (p === this.active) this.lastVideoAt = Date.now();
      return;
    }
    if (p === this.pending) {
      if (!isKey || !p._pendingInit) return;
      // Take over: the old pipeline goes, the new one's keyframe starts a fresh GOP.
      const old = this.active;
      this.active = p;
      this.pending = null;
      if (old) { old.removeAllListeners(); old.on('exit', () => {}); old.kill(); }
      this.gop = []; this.gopRaw = []; this.gopBytes = 0;
      this._applyVideoInit(p._pendingInit.track, p._pendingInit.raw);
      if (p._pendingAudio) this._onAudioInit(p._pendingAudio);
      this.log('recycle complete');
    } else if (p !== this.active) return;

    if (!this.videoConfigMsg) return;
    this.lastVideoAt = Date.now();
    if (this.state !== 'live') {
      this.state = 'live';
      this.liveSince = Date.now();
      this.lastError = null;
      this._clearProblem();
      this.restarts = this.restarts.filter((t) => Date.now() - t < 60000);
      if (p.multicast) noteMulticast(`${this.cameraId}/${this.label}`, true);
      this.manager.onSessionLive(this);
    }
    const msg = P.videoChunk(pts, isKey, data);
    this.stats.frames++;
    this.stats.bytesIn += data.length;
    // How far behind the server clock this frame's PTS is as it goes out.
    // Viewers report delays against the same PTS; subtracting this leaves
    // only the server -> viewer part (camera clock drift cancels out).
    this.ptsLagMs = (nowUs() - pts) / 1000;

    // GOP cache for late joiners
    if (isKey) { this.gop = []; this.gopRaw = []; this.gopBytes = 0; this.gopOverflow = false; }
    if (!this.gopOverflow) {
      this.gop.push(msg);
      if (frag) this.gopRaw.push(frag.raw);
      this.gopBytes += msg.length + (frag ? frag.raw.length : 0);
      if (this.gopBytes > GOP_MAX_BYTES || this.gop.length > GOP_MAX_FRAMES) {
        this.gopOverflow = true; this.gop = []; this.gopRaw = [];
      }
    }

    for (const c of this.clients) c.sendVideo(msg, isKey, this);
    if (frag) for (const r of this.rawConsumers) r.onFragment?.(frag.raw, frag.hasKey);
  }

  _onAudioInit(track) {
    if (track.codec !== 'opus') return;
    this.audioTrack = track;
    this.audioConfigMsg = P.audioConfig(track.channels, track.sampleRate, track.preSkip);
    for (const c of this.clients) if (c.configSent && c.audioMode === 'opus') c.send(this.audioConfigMsg);
  }

  _onAudioSample(pts, data) {
    if (!this.audioConfigMsg) return;
    const msg = P.audioChunk(pts, data);
    for (const c of this.clients) if (c.audioMode === 'opus') c.sendAudio(msg, this);
  }

  _onPcm(pts, data) {
    let msg = null;
    for (const c of this.clients) {
      if (c.audioMode !== 'pcm') continue;
      msg = msg || P.audioPcm(pts, PCM_RATE, 1, data);
      c.sendAudio(msg, this);
    }
  }

  /* --- Consumers --------------------------------------------------------- */

  addClient(c) {
    this.clients.add(c);
    this.ensureRunning();
    c.send(P.streamStart());
    if (this.state === 'failed') c.send(P.streamError(this.lastError || 'Stream failed'));
    else if (this.videoConfigMsg) c.sendConfig(this, /* catchup */ true);
    else if (this.lastError) c.send(P.streamError(this.lastError));
    if (this.problem) c.send(P.streamProblem(this.problem.kind, this.problem.since, this.problem.text));
  }

  removeClient(c) {
    if (!this.clients.delete(c)) return;
    this._scheduleIdle();
  }

  addRaw(r) {
    this.rawConsumers.add(r);
    this.ensureRunning();
    if (this.initRaw) {
      r.onInit?.(this.initRaw);
      for (const f of this.gopRaw) r.onFragment?.(f, false);
    }
  }

  removeRaw(r) {
    if (!this.rawConsumers.delete(r)) return;
    this._scheduleIdle();
  }

  _broadcast(msg, force) {
    for (const c of this.clients) if (force || c.configSent) c.send(msg);
  }

  /** Every viewer drops and reconnects (Recycle Cameras). */
  kickAll(code = 1012, reason = 'recycle') {
    for (const c of [...this.clients]) c.close(code, reason);
  }

  info() {
    const v = this.manager.variantInfo(this.cameraId, this.label) || {};
    return {
      cameraId: this.cameraId, variant: this.label, state: this.state,
      clients: this.clients.size, internalConsumers: this.rawConsumers.size,
      pid: this.active?.proc?.pid || null, uptimeMs: this.liveSince ? Date.now() - this.liveSince : 0,
      videoCodec: this.track?.codec || v.videoCodec || null, width: this.track?.width || null, height: this.track?.height || null,
      audio: this.audioConfigMsg ? 'opus' : (this.audioAvailable === false ? 'none' : null),
      kbps: Math.round((this._bpsSample.bps * 8) / 1000), fps: Math.round(this._bpsSample.fps * 10) / 10,
      inKbps: Math.round((this._bpsSample.inBps * 8) / 1000), multicast: !!this.active?.multicast,
      multicastWanted: this.multicastWanted,
      ptsLagMs: this.ptsLagMs == null ? null : Math.round(this.ptsLagMs),
      cpuPct: this.manager.metrics?.pidCpu.get(this.active?.proc?.pid) ?? null,
      rss: this.manager.metrics?.pidRss.get(this.active?.proc?.pid) ?? null,
      gopFrames: this.gop.length, lastError: this.lastError, problem: this.problem, ...this.stats,
    };
  }
}

module.exports = { StreamSession, SOFT_CAP, HARD_CAP };
