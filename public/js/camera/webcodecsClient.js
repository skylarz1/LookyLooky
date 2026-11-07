/**
 * Claudifer WebCodecs stream client (LookyLooky).
 *
 * Connects to the server's WebSocket, subscribes to one camera, decodes H.264
 * via WebCodecs' VideoDecoder and Opus via AudioDecoder, and paces playback
 * against a shared monotonic clock so video, audio, and any sibling client on
 * the page stay in lockstep without drifting.
 *
 * Usage (ES module):
 *   import { WebCodecsClient, CanvasVideoRenderer } from '/js/camera/webcodecsClient.js';
 *
 *   const client = new WebCodecsClient({
 *     wsUrl:    `ws://${location.host}`,
 *     cameraId: 'cam-01',
 *     renderer: new CanvasVideoRenderer(myCanvasElement),
 *     bufferMs: 150,
 *     muted:    true,
 *     onStatus: (state, detail) => console.log(state, detail),
 *   });
 *   client.start();
 *
 * The renderer is pluggable — a future WebGLVideoRenderer can slot in the
 * same hole without touching the rest of the client.
 *
 * LookyLooky changes against the original (see VENDORED.md):
 *   • Audio on browsers with VideoDecoder but no AudioDecoder — Safari before
 *     26, which is every iPad 6th gen (last OS: iPadOS 17).  Those subscribe
 *     with audio:'pcm' and get 16 kHz G.711 mu-law (AUDIO_PCM), decoded and
 *     resampled here and fed to the same AudioWorklet.
 *   • iOS audio unlock: touchend/pointerup as well as touchstart, and the
 *     audio session set to 'playback' so the ringer switch does not mute it.
 *   • Live-edge join: catch-up frames (the server's cached GOP) re-anchor the
 *     playout clock onto the newest one, so a late joiner starts live.
 *   • Latency guard: if frames sit in the jitter buffer far longer than
 *     bufferMs for a couple of seconds (a probe burst on start, or a camera
 *     clock running fast), the clock is pulled back to the live edge.
 *   • Audio is only sent to a pane that can be heard: mute/unmute tells the
 *     server, so muted panes cost no audio bandwidth.
 *   • The worklet is loaded relative to this module (import.meta.url), so the
 *     client works from any page and any origin.
 */

// ─── Wire protocol constants (mirror lib/streamProtocol.js) ────────────
const PROTOCOL_VERSION = 0x01;
const MSG_STREAM_START = 0x01;
const MSG_VIDEO_CONFIG = 0x02;
const MSG_VIDEO_CHUNK  = 0x03;
const MSG_AUDIO_CONFIG = 0x04;
const MSG_AUDIO_CHUNK  = 0x05;
const MSG_STREAM_RESET = 0x06;
const MSG_STREAM_ERROR = 0x07;
const MSG_JPEG_FRAME   = 0x08;
const MSG_AUDIO_PCM    = 0x09;
// STREAM_PROBLEM: kind(u8) ageSec(u32 BE) UTF-8 reason — why there is no
// picture.  kind: 0 cleared, 1 camera unreachable, 2 camera network down,
// 3 no video, 4 camera error.  ageSec = seconds since the picture was lost.
// Mirrors server/protocol.js; older servers never send it.
const MSG_STREAM_PROBLEM = 0x0a;
const PROBLEM_KINDS = ['clear', 'network', 'network-down', 'no-video', 'camera'];

/** Decode a STREAM_PROBLEM into { kind, since (ms, this clock), text }. */
function parseProblem(view) {
  if (view.byteLength < 7) return null;
  const age = view.getUint32(3, false);
  return {
    kind:  PROBLEM_KINDS[view.getUint8(2)] || 'camera',
    since: age ? Date.now() - age * 1000 : Date.now(),
    text:  new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset + 7, view.byteLength - 7)),
  };
}
const FLAG_KEYFRAME    = 0x01;
const FLAG_CATCHUP     = 0x02;

// G.711 mu-law → linear float.  256 entries, built once.
const MULAW_TABLE = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80, exp = (u >> 4) & 0x07, mant = u & 0x0f;
    let s = ((mant << 3) + 0x84) << exp;
    s -= 0x84;
    t[i] = (sign ? -s : s) / 32768;
  }
  return t;
})();

/** Which audio path this browser can take. */
export function audioCapability() {
  if (typeof AudioDecoder !== 'undefined') return 'opus';
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (AC && typeof AudioWorkletNode !== 'undefined') return 'pcm';
  return 'none';
}

// ─── Video renderer — 2D canvas implementation ─────────────────────────
/**
 * Draws VideoFrames to a plain <canvas> via a 2D context.  Resizes the
 * canvas backing store to match the source frame on first frame / resolution
 * change.  CSS layout sizing is the caller's responsibility.
 *
 * Renderers own the lifecycle of the VideoFrame they receive: they must call
 * `frame.close()` after drawing.  VideoFrames are backed by GPU/Shared
 * resources and leak fast if not released.
 */
export class CanvasVideoRenderer {
  constructor(canvas) {
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this._lastW = 0;
    this._lastH = 0;
  }

  drawFrame(frame) {
    try {
      if (!this._ctx) { frame.close(); return; }
      const w = frame.displayWidth;
      const h = frame.displayHeight;
      if (w !== this._lastW || h !== this._lastH) {
        this._canvas.width = w;
        this._canvas.height = h;
        this._lastW = w;
        this._lastH = h;
      }
      this._ctx.drawImage(frame, 0, 0, w, h);
    } finally {
      frame.close();
    }
  }

  destroy() {
    this._ctx = null;
    this._canvas = null;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function readBigInt64LE(view, offset) {
  // Number conversion is safe for PTS µs values up to ~285 years of uptime.
  return Number(view.getBigInt64(offset, /* littleEndian */ true));
}

// ─── Shared AudioContext ───────────────────────────────────────────────
//
// All WebCodecsClient instances share a single AudioContext for three
// reasons:
//   1. Chrome's autoplay policy only unsuspends an AudioContext in response
//      to a user gesture.  The original AUDIO_CONFIG arrives asynchronously
//      — if we create the context there, the gesture that just triggered
//      the subscribe (e.g. a layout-switch click) has already ended, and
//      the context stays permanently suspended.  A page-level context
//      created once and unlocked by any gesture survives layout churn.
//   2. Browsers cap AudioContext instances per page (hundreds, but finite).
//      Closing/creating on every layout switch wastes resources.
//   3. A shared clock simplifies future cross-pane audio sync if needed.

let _sharedAudioCtx = null;
let _workletModulePromise = null;

/**
 * Load the AudioWorklet processor module once per page.  Subsequent callers
 * await the same promise so we never race addModule() across multiple clients.
 */
function ensureWorkletLoaded(ctx) {
  if (_workletModulePromise) return _workletModulePromise;
  if (!ctx?.audioWorklet) {
    _workletModulePromise = Promise.reject(new Error('AudioWorklet unsupported'));
    return _workletModulePromise;
  }
  // Resolved against THIS module, not the document — addModule() would
  // otherwise resolve a relative path against whatever page hosts the grid.
  _workletModulePromise = ctx.audioWorklet.addModule(new URL('./audioWorkletProcessor.js', import.meta.url).href);
  return _workletModulePromise;
}

function getSharedAudioContext() {
  if (_sharedAudioCtx) return _sharedAudioCtx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    _sharedAudioCtx = new AC({ sampleRate: 48000, latencyHint: 'interactive' });
  } catch {
    // Older WebKit rejects the options bag or the rate; the PCM path
    // resamples to whatever rate the context ends up with.
    _sharedAudioCtx = new AC();
  }
  // iOS 17+: play through the ringer/silent switch like a video would.
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* not iOS */ }

  // Optimistic resume — if the site has autoplay Allowed (Chrome/Edge site
  // setting "Sound: Allow", or the user has sufficient Media Engagement
  // Index), the context transitions to 'running' silently and audio plays
  // without waiting for a gesture.  If autoplay is blocked this call
  // rejects (with one Chrome warning) and the context stays suspended
  // until the unlock listener below resumes it on the first real gesture.
  _sharedAudioCtx.resume().catch(() => {});

  const unlock = () => {
    if (_sharedAudioCtx.state !== 'running') {
      _sharedAudioCtx.resume().catch(() => {});
      // Older iOS only unlocks once something has actually been started
      // inside the gesture — a one-sample silent buffer does it.
      try {
        const b = _sharedAudioCtx.createBuffer(1, 1, _sharedAudioCtx.sampleRate);
        const src = _sharedAudioCtx.createBufferSource();
        src.buffer = b; src.connect(_sharedAudioCtx.destination); src.start(0);
      } catch { /* ignore */ }
    }
  };
  // Use capture phase + passive so we don't interfere with any page handler.
  // iOS Safari only counts touchend (not touchstart) as activation.
  const opts = { capture: true, passive: true };
  for (const ev of ['click', 'keydown', 'touchstart', 'touchend', 'pointerup']) window.addEventListener(ev, unlock, opts);
  return _sharedAudioCtx;
}

/**
 * Public warmup hook — creates the shared AudioContext and installs the
 * user-gesture unlock listener early (e.g. from the CameraGrid constructor),
 * before any client has received AUDIO_CONFIG.  Without this warmup, a
 * user click that arrives before the first audio config is created lands
 * with no listener yet and its gesture-activation token expires unused;
 * subsequent audio never plays until the user clicks again.
 */
export function ensureSharedAudioContext() {
  return getSharedAudioContext();
}

// ─── Hardware-decode probe ─────────────────────────────────────────────
//
// codec string → Promise<'prefer-hardware' | 'no-preference'>, once per page.
// Chromium treats 'prefer-hardware' as a requirement, so on a machine with no
// hardware decoder for the codec, configure() fails outright.  Asking first
// (and remembering) means no pane ever loses its first keyframe to that.
const _hwProbe = new Map();
function hardwareModeFor(codec, description) {
  if (_hwProbe.has(codec)) return _hwProbe.get(codec);
  const p = (async () => {
    try {
      const r = await VideoDecoder.isConfigSupported({ codec, description, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
      return r.supported ? 'prefer-hardware' : 'no-preference';
    } catch { return 'no-preference'; }
  })();
  _hwProbe.set(codec, p);
  return p;
}

// ─── Active-decoder counter ────────────────────────────────────────────
//
// Exposed on window for DevTools inspection during troubleshooting.  Tracks
// how many VideoDecoder instances this page currently holds open — one per
// pane that's actively decoding.  Each hardware HEVC slot the GPU exposes
// corresponds to one open decoder, so this is a proxy for "how much GPU
// decoder pressure am I applying right now."  Under normal use it should
// match the number of on-screen panes; if it stays high after tabbing away
// or scrolling past panes, something in the close path isn't running.
let _activeDecoderCount = 0;
function _incrementActiveDecoderCount() {
  _activeDecoderCount++;
  if (typeof window !== 'undefined') window.__claudiferActiveDecoders = _activeDecoderCount;
}
function _decrementActiveDecoderCount() {
  if (_activeDecoderCount > 0) _activeDecoderCount--;
  if (typeof window !== 'undefined') window.__claudiferActiveDecoders = _activeDecoderCount;
}

// ─── Thumbnail client ───────────────────────────────────────────────────
/**
 * The low-cost render tier: subscribes to a camera's JPEG feed over a
 * WebSocket and paints each frame to a canvas.  No VideoDecoder, no
 * AudioDecoder, no playout clock — so it consumes none of the GPU's fixed
 * hardware decode slots, which is the whole reason the tier exists.
 *
 * Why a WebSocket rather than `<img src="/stream/:id/mjpeg">`: browsers cap
 * HTTP/1.1 at six connections per origin and a multipart <img> holds one open
 * indefinitely.  Past six thumbnails the extra panes never load, and the
 * dashboard's own /api polling starves behind them.  WebSockets use a
 * separate, far larger pool.
 *
 * Frames are decoded with createImageBitmap (off the main thread, and no
 * object-URL churn to leak).  Only one decode is in flight at a time: if
 * frames arrive faster than they decode, the newest wins and the rest are
 * dropped — thumbnails are "latest frame" by nature, and a backlog would only
 * add latency.
 */
export class ThumbnailClient {
  /**
   * @param {object} opts
   * @param {string} opts.wsUrl
   * @param {string} opts.cameraId
   * @param {HTMLCanvasElement} opts.canvas
   * @param {(state:string, detail?:any)=>void} [opts.onStatus]
   */
  constructor({ wsUrl, cameraId, canvas, onStatus, onFirstFrame } = {}) {
    if (!wsUrl)    throw new Error('ThumbnailClient: wsUrl required');
    if (!cameraId) throw new Error('ThumbnailClient: cameraId required');
    if (!canvas)   throw new Error('ThumbnailClient: canvas required');

    this._wsUrl    = wsUrl;
    this._cameraId = cameraId;
    this._canvas   = canvas;
    this._ctx      = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this._onStatus = onStatus || (() => {});
    // Same contract as WebCodecsClient's: fires once, on the first painted
    // frame.  A camera whose MJPEG process isn't running yet takes an FFmpeg
    // spawn plus an RTSP connect to produce one.
    this._onFirstFrame = onFirstFrame || (() => {});
    this._firstFrameSent = false;

    this._ws      = null;
    this._stopped = false;
    this._reconnectTimer = null;
    // Same backoff shape as WebCodecsClient: a grid of thumbnails all
    // reconnecting in lockstep after a server restart is the exact stampede
    // the jitter is there to break up.
    this._reconnectDelayBase    = 2_000;
    this._reconnectDelayMax     = 30_000;
    this._reconnectDelayCurrent = 2_000;
    this._connectedAt = 0;

    this._decoding  = false;
    this._pending   = null;   // newest frame awaiting decode
    this._frames    = 0;
    this._lastW     = 0;
    this._lastH     = 0;

    this._bytesSinceSample = 0;
    this._bytesPerSec      = 0;
    this._lastSampleAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    // A hidden tab still receives frames but can't show them; decoding them
    // is pure waste.  Cheap to honour since there's no decoder state to
    // rebuild — we simply resume painting on the next frame.
    this._tabVisible = document.visibilityState !== 'hidden';
    this._paneVisible = true;
    this._visibilityHandler = () => {
      this._tabVisible = document.visibilityState !== 'hidden';
    };
  }

  /**
   * IntersectionObserver hook, mirroring WebCodecsClient's.  A scrolled-off
   * thumbnail keeps its subscription (reconnecting costs more than the bytes
   * save) but stops decoding — createImageBitmap on frames nobody can see is
   * the only real cost in this tier.
   */
  setPaneVisible(visible) { this._paneVisible = !!visible; }

  start() {
    if (this._ws) return;
    this._stopped = false;
    if (!this._visibilityListenerAttached) {
      document.addEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityListenerAttached = true;
    }
    this._status('connecting');
    this._connect();
  }

  stop() {
    this._stopped = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._visibilityListenerAttached) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityListenerAttached = false;
    }
    if (this._pending) { this._pending = null; }
    if (this._ws) {
      try {
        if (this._ws.readyState === WebSocket.OPEN) {
          this._ws.send(JSON.stringify({ action: 'unsubscribeThumb', cameraId: this._cameraId }));
        }
      } catch { /* socket already going away */ }
      try { this._ws.close(); } catch { /* ignore */ }
      this._ws = null;
    }
    this._ctx = null;
    this._canvas = null;
    this._status('closed');
  }

  getStats() { return { frames: this._frames }; }

  /** Matches WebCodecsClient's shape so the grid can sum both tiers. */
  getReceivedBytesPerSec() {
    const now = performance.now();
    const elapsedSec = (now - this._lastSampleAt) / 1000;
    if (elapsedSec <= 0) return this._bytesPerSec;
    this._bytesPerSec = this._bytesSinceSample / elapsedSec;
    this._bytesSinceSample = 0;
    this._lastSampleAt = now;
    return this._bytesPerSec;
  }

  _connect() {
    const ws = new WebSocket(this._wsUrl);
    ws.binaryType = 'arraybuffer';
    this._ws = ws;

    ws.addEventListener('open', () => {
      this._connectedAt = performance.now();
      ws.send(JSON.stringify({ action: 'subscribeThumb', cameraId: this._cameraId }));
      this._status('subscribed');
    });

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') return;  // JSON acks are informational
      const size = ev.data?.byteLength || 0;
      this._bytesSinceSample += size;
      if (size < 2) return;
      const view = new DataView(ev.data);
      if (view.getUint8(0) !== PROTOCOL_VERSION) return;
      if (view.getUint8(1) === MSG_STREAM_PROBLEM) { this._onProblem(parseProblem(view)); return; }
      if (view.getUint8(1) !== MSG_JPEG_FRAME)   return;
      this._onJpeg(new Uint8Array(ev.data, 2, size - 2));
    });

    ws.addEventListener('error', () => this._status('error', 'websocket error'));

    ws.addEventListener('close', () => {
      this._ws = null;
      if (this._stopped) return;
      const lifetimeMs = this._connectedAt ? performance.now() - this._connectedAt : 0;
      this._connectedAt = 0;
      this._reconnectDelayCurrent = lifetimeMs > 30_000
        ? this._reconnectDelayBase
        : Math.min(this._reconnectDelayCurrent * 2, this._reconnectDelayMax);
      const jitter = 0.75 + Math.random() * 0.5;
      this._status('reconnecting');
      this._reconnectTimer = setTimeout(() => this._connect(),
        Math.round(this._reconnectDelayCurrent * jitter));
    });
  }

  /** The next JPEG reports 'streaming' again, which clears the pane's overlay. */
  _onProblem(p) {
    if (!p) return;
    this._problem = p.kind !== 'clear';
    this._status('problem', p);
  }

  /**
   * Queue a frame for painting.  `_pending` holds at most one frame — a
   * newer arrival replaces an undecoded older one, so a slow decode can
   * never build a backlog.  The bytes are copied out of the WebSocket
   * message buffer because that view is invalid once the handler returns.
   */
  _onJpeg(bytes) {
    if (this._stopped || !this._tabVisible || !this._paneVisible) return;
    this._pending = bytes.slice();
    if (this._decoding) return;
    this._drainPending();
  }

  async _drainPending() {
    this._decoding = true;
    try {
      while (this._pending && !this._stopped) {
        const bytes = this._pending;
        this._pending = null;
        let bitmap;
        try {
          bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        } catch {
          continue;  // truncated / malformed frame; the next one will be fine
        }
        if (this._stopped || !this._ctx) { bitmap.close(); return; }
        if (bitmap.width !== this._lastW || bitmap.height !== this._lastH) {
          this._canvas.width  = bitmap.width;
          this._canvas.height = bitmap.height;
          this._lastW = bitmap.width;
          this._lastH = bitmap.height;
        }
        this._ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        if (this._frames++ === 0 || this._problem) {
          this._problem = false;
          this._status('streaming');
          if (!this._firstFrameSent) {
            this._firstFrameSent = true;
            try { this._onFirstFrame(); } catch { /* host callback errors are theirs */ }
          }
        }
      }
    } finally {
      this._decoding = false;
    }
  }

  _status(state, detail) {
    try { this._onStatus(state, detail); } catch { /* listener errors are theirs */ }
  }
}

// ─── Main client ────────────────────────────────────────────────────────
export class WebCodecsClient {
  /**
   * @param {object} opts
   * @param {string} opts.wsUrl        WebSocket URL — usually `ws://${location.host}`
   * @param {string} opts.cameraId     camera to subscribe to
   * @param {object} opts.renderer     VideoRenderer instance (e.g. CanvasVideoRenderer)
   * @param {number} [opts.bufferMs]   playout jitter buffer (default 150)
   * @param {boolean}[opts.muted]      start muted (default true)
   * @param {number} [opts.volume]     0-1 (default 1)
   * @param {(state:string, detail?:any)=>void} [opts.onStatus]
   * @param {(err:Error)=>void} [opts.onError]
   * @param {()=>void} [opts.onKicked]  called when the server closes us with
   *   code 1013 ("slow consumer").  The host pane should shed load before
   *   the automatic reconnect fires — typically by forcing the variant down
   *   to `sub` — otherwise the retry runs at the same bitrate that just
   *   failed and the kick loop repeats.
   */
  constructor({ wsUrl, cameraId, renderer, quality, bufferMs = 150, muted = true, volume = 1, onStatus, onError, onKicked, onFirstFrame } = {}) {
    if (!wsUrl)    throw new Error('WebCodecsClient: wsUrl required');
    if (!cameraId) throw new Error('WebCodecsClient: cameraId required');
    if (!renderer) throw new Error('WebCodecsClient: renderer required');

    this._wsUrl    = wsUrl;
    this._cameraId = cameraId;
    this._renderer = renderer;
    // Variant label to subscribe to (e.g. "main" / "sub").  Sent in the
    // subscribe message; server falls back to its main / first variant when
    // omitted or unknown and echoes the served label in the `subscribed`
    // ack so the caller can confirm what it got.
    this._quality  = quality || null;
    // 'opus' (AudioDecoder), 'pcm' (Safari < 26 — iPad 6th gen) or 'none'.
    this._audioMode = audioCapability();
    this._pcmResample = { pos: 0, last: 0 };
    this._bufferMs = bufferMs;
    // Latency guard (see _guardLatency): the smallest "time until due" seen
    // over the current window.
    this._leadWindowStart = 0;
    this._leadMin = Infinity;
    this._muted    = muted;
    this._volume   = volume;
    this._onStatus = onStatus || (() => {});
    this._onError  = onError  || (() => {});
    this._onKicked = onKicked || (() => {});
    // Fires once, when a decoded frame is actually painted — NOT when the
    // stream reports 'streaming', which happens at VIDEO_CONFIG and can
    // precede the first picture by seconds (an RTSP connect plus a wait for
    // the camera's next keyframe).  The host uses this to know when it's safe
    // to take down whatever was covering the pane in the meantime.
    this._onFirstFrame = onFirstFrame || (() => {});
    this._firstFrameSent = false;

    // Connection state.  Reconnects use exponential backoff with jitter:
    // a fixed short delay turns a struggling client into a kick/reconnect
    // metronome — every backed-up pane on the machine gets kicked in the
    // same server broadcast pass, then all of them reconnect in lockstep
    // 2 s later, each rebuilding a hardware decoder simultaneously.  On a
    // weak PC that loop repeats forever, and sustained decoder create/
    // destroy churn is a known trigger for wedging Chrome's GPU process.
    // Backoff spreads the retries out (2 s → 4 → 8 → … → 30 s cap), the
    // ±25% jitter de-synchronizes panes from each other, and a connection
    // that survives 30 s is considered healthy and resets the ladder.
    this._ws          = null;
    this._stopped     = false;
    this._reconnectTimer = null;
    this._reconnectDelayBase    = 2_000;
    this._reconnectDelayMax     = 30_000;
    this._reconnectDelayCurrent = 2_000;
    this._connectedAt = 0;

    // Rate-limit for fatal-decoder-error rebuilds (see _scheduleDecoderRebuild).
    this._decoderRebuildTimer = null;

    // Decoders
    this._videoDecoder      = null;
    this._videoCodecString  = null;
    this._videoCodecRecord  = null;  // raw AVCC/HVCC bytes, cached for re-configure
    this._audioDecoder = null;
    this._audioCtx     = null;
    this._audioGain    = null;
    this._audioWorklet = null;  // persistent AudioWorkletNode — replaces the
                                // per-packet BufferSourceNode pipeline

    // Set to true while the tab is hidden, so we can resume video decoding
    // from the next keyframe rather than the next delta (which the decoder
    // would reject because it skipped its reference frame).
    this._waitingForKeyframe = false;

    // Two axes of visibility, combined into `_effectivelyVisible`:
    //   _paneVisible — set by the host via setPaneVisible; driven by an
    //     IntersectionObserver on the pane element (scrolled off-screen or
    //     collapsed layout).
    //   _tabVisible — set by our own visibilitychange listener; false when
    //     the tab is hidden, minimized, or the OS moved us to a workspace
    //     the user isn't looking at.
    // Either false ⇒ chunks are dropped and, after a grace window, the
    // VideoDecoder is closed to release its hardware decode slot.  GPUs
    // typically expose ~4–8 hardware HEVC slots; with 10+ panes, panes
    // holding slots they aren't showing forces the rest into slow software
    // decode (or, worse under sustained load, wedges Chrome's GPU process).
    this._paneVisible        = true;
    this._tabVisible         = document.visibilityState !== 'hidden';
    // Grace before closing decoder for each reason.  Off-screen uses 15 s
    // because "scrolled past for a second" is common and rebuild is
    // user-visible; tab-hidden uses 3 s because the user is definitely
    // not looking at us and slot pressure is the whole reason we're doing
    // this.  When both apply, the shorter timeout wins.
    this._offScreenIdleMs    = 15_000;
    this._tabHiddenIdleMs    =  3_000;
    this._offScreenIdleTimer = null;
    // Bound handler kept as a field so start()/stop() can add/remove it
    // symmetrically without re-binding losing the reference.
    this._visibilityHandler  = () => this.setTabVisible(document.visibilityState !== 'hidden');

    // Rolling sample of `videoDecoder.decodeQueueSize`, updated from the
    // rAF loop.  Used by `getDecoderPressure()` so the host (CameraPane)
    // can decide when to auto-downgrade to the substream.
    this._pressureSamples    = [];
    this._pressureFrameCount = 0;

    // Playout clock — anchored on the first video chunk seen.
    // `_anchorServerUs` is that chunk's server-side PTS (µs).
    // `_anchorPerfMs`   is the performance.now() at which the chunk should render.
    // `_anchorCtxTime`  is the AudioContext time at the same instant.
    this._anchorServerUs = null;
    this._anchorPerfMs   = 0;
    this._anchorCtxTime  = 0;

    // Jitter buffer for decoded video frames, sorted by timestamp ascending.
    this._videoQueue = [];

    // Running stats
    this._rafId        = 0;
    this._stats        = { framesRendered: 0, framesDropped: 0, audioScheduled: 0, audioDropped: 0 };

    // Delay report for the server's statistics (_sendReport, every 5 s).
    // `_clockOffsetMs` maps performance.now() onto the server's clock (the
    // one video PTS are on), from the ping with the shortest round trip.
    this._clockOffsetMs = null;
    this._pings         = [];
    this._arrivalLags   = [];
    this._renderLags    = [];
    this._reportTimer   = 0;
    this._lastReport    = null;

    // Bytes received on the WebSocket since the last throughput sample.
    // Surfaced via getReceivedBytesPerSec().  The grid aggregates across
    // panes for the dashboard-wide bandwidth display.
    this._bytesSinceSample = 0;
    this._bytesPerSec      = 0;
    this._lastSampleAt     = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  }

  // ── Public API ──────────────────────────────────────────────────────

  start() {
    if (this._ws) return;
    this._stopped = false;
    this._status('connecting');
    // Attach here (not in the constructor) so setup and teardown are
    // symmetric — a client that's never started shouldn't hold a global
    // listener.  visibilitychange is same-arg-instance-idempotent per
    // spec, but we still guard against double-add.
    if (!this._visibilityListenerAttached) {
      document.addEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityListenerAttached = true;
    }
    this._connect();
    this._rafId = requestAnimationFrame(() => this._rafTick());
  }

  stop() {
    this._stopped = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = 0; }
    this._tearDown();
    this._status('closed');
  }

  setMuted(muted) {
    const changed = this._muted !== muted;
    this._muted = muted;
    // Muted panes are sent no audio at all.
    if (changed && this._ws?.readyState === WebSocket.OPEN) {
      try { this._ws.send(JSON.stringify({ action: 'audio', enabled: !muted })); } catch { /* closing */ }
    }
    if (this._audioGain) this._audioGain.gain.value = muted ? 0 : this._volume;
    // Unmute is typically called from a user gesture (pane click to focus).
    // Resume the shared context even when this client doesn't have a gain
    // node yet: if AUDIO_CONFIG hasn't arrived, gain is null — but the
    // gesture token is still live on *this* call, so we should spend it
    // now, before it expires.  When the config eventually arrives, the
    // context will already be running and audio plays immediately.
    if (!muted) {
      const ctx = getSharedAudioContext();
      if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
    }
  }

  setVolume(volume) {
    this._volume = Math.max(0, Math.min(1, volume));
    if (this._audioGain && !this._muted) this._audioGain.gain.value = this._volume;
  }

  /**
   * Counters plus the visibility inputs that gate decoding.
   *
   * `paneVisible` / `tabVisible` are included because they are the only way to
   * explain a `pausedDrops` count from outside: pane-false means the
   * IntersectionObserver believes this pane is off-screen, tab-false means the
   * document is hidden. A frozen pane with pausedDrops climbing and
   * paneVisible false — while the pane is plainly on screen — is a stuck
   * visibility state machine, not a decoder fault.
   */
  getStats() {
    return {
      ...this._stats,
      videoQueue: this._videoQueue.length,
      paneVisible: this._paneVisible,
      tabVisible: this._tabVisible,
      decodingPaused: this._decodingPaused(),
    };
  }

  /**
   * Rough "are we still live?" check.  Normal steady-state values are tiny
   * — a handful of queued chunks and one or two decoded frames awaiting
   * render.  Returns true when either number is large enough that the user
   * would see stale content until the backlog drains.  The thresholds allow
   * ~1 s of slack at 30 fps so ordinary jitter doesn't count as "behind".
   */
  isBehind() {
    const decoderQ = this._videoDecoder?.decodeQueueSize ?? 0;
    return decoderQ > 30 || this._videoQueue.length > 30;
  }

  /**
   * Bytes/sec received on this client's WebSocket, averaged over the
   * elapsed time since the last call.  Each call resets the window —
   * intended to be called on a fixed cadence by the grid (every ~2 s).
   * Returns 0 if no time has elapsed.
   */
  getReceivedBytesPerSec() {
    const now = performance.now();
    const elapsedSec = (now - this._lastSampleAt) / 1000;
    if (elapsedSec <= 0) return this._bytesPerSec;
    this._bytesPerSec = this._bytesSinceSample / elapsedSec;
    this._bytesSinceSample = 0;
    this._lastSampleAt = now;
    return this._bytesPerSec;
  }

  /**
   * Rolling-average decoder queue depth (chunks awaiting decode).  Sampled
   * from the rAF loop at ~2 Hz over a ~5 s window.  Higher = decoder can't
   * keep up with the incoming bitrate, typically because the GPU is
   * saturated (too many streams) or a motion burst pushed a single stream's
   * frame size up.  The host pane uses this to drive adaptive variant
   * downgrade.
   */
  getDecoderPressure() {
    if (this._pressureSamples.length === 0) return 0;
    let sum = 0;
    for (const s of this._pressureSamples) sum += s;
    return sum / this._pressureSamples.length;
  }

  /**
   * IntersectionObserver-driven visibility on the pane element.  See the
   * unified `_syncVisibility()` below for the actual state machine — this
   * just flips one input and delegates.
   */
  setPaneVisible(visible) {
    const now = !!visible;
    if (this._paneVisible === now) return;
    this._paneVisible = now;
    this._syncVisibility();
  }

  /**
   * visibilitychange-driven visibility on the whole tab.  A hidden tab
   * (background tab, minimized window, off-workspace) can't render
   * anything the user sees, so decoders should be closed aggressively
   * to release their hardware slots — sustained accumulation of held
   * slots across tabs is the leading trigger for Chrome's GPU-process
   * wedge under heavy HEVC load.
   */
  setTabVisible(visible) {
    const now = !!visible;
    if (this._tabVisible === now) return;
    this._tabVisible = now;
    this._syncVisibility();
  }

  /**
   * Single close-timer state machine driven by the effective visibility
   * (_paneVisible AND _tabVisible).  When effective visibility flips
   * true → false, schedule a close with the shortest applicable timeout.
   * When it flips false → true, cancel any pending close and rebuild the
   * decoder from cached config if it was already closed.
   */
  _syncVisibility() {
    const effective = this._paneVisible && this._tabVisible;

    if (effective) {
      if (this._offScreenIdleTimer) {
        clearTimeout(this._offScreenIdleTimer);
        this._offScreenIdleTimer = null;
      }
      // Decoder was closed while we were hidden — rebuild it from the
      // cached config and wait for the next keyframe before resuming.
      if (!this._videoDecoder && this._videoCodecRecord) {
        if (this._createVideoDecoder()) this._waitingForKeyframe = true;
      }
      return;
    }

    // Something made us not-effectively-visible.  Pick the shorter of the
    // applicable timeouts so tab-hidden preempts a pending off-screen close.
    let idleMs = Infinity;
    if (!this._paneVisible) idleMs = Math.min(idleMs, this._offScreenIdleMs);
    if (!this._tabVisible)  idleMs = Math.min(idleMs, this._tabHiddenIdleMs);

    if (this._offScreenIdleTimer) clearTimeout(this._offScreenIdleTimer);
    this._offScreenIdleTimer = setTimeout(() => {
      this._offScreenIdleTimer = null;
      // Race: became effectively visible again in the interim.
      if (this._paneVisible && this._tabVisible) return;
      if (this._videoDecoder) {
        _decrementActiveDecoderCount();
        try { this._videoDecoder.close(); } catch { /* ignore */ }
        this._videoDecoder = null;
      }
      // Drop any queued frames — they're stale; next start will rebuild
      // from a fresh keyframe.
      for (const f of this._videoQueue) f.close();
      this._videoQueue = [];
    }, idleMs);
  }

  /** True when video decoding should be paused — tab hidden OR pane off-screen. */
  _decodingPaused() {
    return !this._paneVisible || !this._tabVisible;
  }

  // ── WebSocket connection ────────────────────────────────────────────

  _connect() {
    const ws = new WebSocket(this._wsUrl);
    ws.binaryType = 'arraybuffer';
    this._ws = ws;

    ws.addEventListener('open', () => {
      this._connectedAt = performance.now();
      const msg = { action: 'subscribe', cameraId: this._cameraId, audio: this._audioMode, audioEnabled: !this._muted };
      if (this._quality) msg.quality = this._quality;
      ws.send(JSON.stringify(msg));
      this._lastReport = null;
      this._sendPing();
      clearInterval(this._reportTimer);
      this._reportTimer = setInterval(() => { this._sendPing(); this._sendReport(); }, 5000);
    });

    ws.addEventListener('message', (ev) => {
      // Tally throughput first so the per-pane stat reflects the wire
      // bytes whether or not we end up using the message.
      const size = typeof ev.data === 'string'
        ? ev.data.length
        : (ev.data?.byteLength || 0);
      this._bytesSinceSample += size;
      if (typeof ev.data === 'string') {
        this._handleJSON(ev.data);
      } else {
        this._handleBinary(ev.data);
      }
    });

    ws.addEventListener('error', () => {
      // The close event will follow; log and let close handle reconnect.
      this._status('error', 'websocket error');
    });

    ws.addEventListener('close', (ev) => {
      this._ws = null;
      clearInterval(this._reportTimer);
      this._reportTimer = 0;
      this._resetDecoders();
      if (this._stopped) return;

      // 1013 = the server kicked us as a slow consumer (WS buffer passed
      // the hard cap).  Give the host a chance to shed load — the pane
      // typically forces a downgrade to `sub`, which resyncs with a new
      // client and stops us.  Re-check _stopped afterwards.
      if (ev.code === 1013) {
        try { this._onKicked(); } catch { /* host callback errors are theirs */ }
        if (this._stopped) return;
      }

      // Backoff ladder: a connection that survived 30 s was healthy, so
      // start over from the base delay; anything shorter doubles the wait
      // up to the cap.  ±25% jitter keeps a grid of panes from retrying
      // in lockstep after a mass kick.
      const lifetimeMs = this._connectedAt ? performance.now() - this._connectedAt : 0;
      this._connectedAt = 0;
      this._reconnectDelayCurrent = lifetimeMs > 30_000
        ? this._reconnectDelayBase
        : Math.min(this._reconnectDelayCurrent * 2, this._reconnectDelayMax);
      const jitter = 0.75 + Math.random() * 0.5;
      const delay  = Math.round(this._reconnectDelayCurrent * jitter);

      this._status('reconnecting');
      this._reconnectTimer = setTimeout(() => this._connect(), delay);
    });
  }

  _handleJSON(text) {
    if (this._stopped) return;  // message arrived after stop(); ignore.
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.type === 'error') {
      this._onError(new Error(msg.message || 'server error'));
      this._status('error', msg.message);
    }
    if (msg.type === 'pong' && typeof msg.mono === 'number' && typeof msg.c === 'number') {
      const rtt = performance.now() - msg.c;
      this._pings.push({ rtt, offset: msg.c + rtt / 2 - msg.mono });
      if (this._pings.length > 6) this._pings.shift();   // the last ~30 s
      this._clockOffsetMs = this._pings.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
    }
    // 'subscribed' / 'unsubscribed' / 'cameras' ack messages are informational.
  }

  _sendPing() {
    if (this._ws?.readyState !== WebSocket.OPEN) return;
    try { this._ws.send(JSON.stringify({ action: 'ping', c: performance.now() })); } catch { /* closing */ }
  }

  /**
   * What this pane actually got, for the server's statistics page: frames
   * drawn and dropped since the last report, the decoder backlog, and how
   * long frames took from the server to arrive and to reach the screen
   * (on the server's clock; the server subtracts its own input delay).
   */
  _sendReport() {
    const ws = this._ws;
    if (ws?.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    const st = this._stats;
    const prev = this._lastReport;
    this._lastReport = { at: now, rendered: st.framesRendered, dropped: st.framesDropped };
    if (!prev) { this._arrivalLags = []; this._renderLags = []; return; }
    const dt = (now - prev.at) / 1000;
    const spread = (list) => {
      if (!list.length) return null;
      const s = list.sort((a, b) => a - b);
      const at = (q) => Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]);
      return { p50: at(0.5), p95: at(0.95), max: Math.round(s[s.length - 1]) };
    };
    const report = {
      action: 'report',
      fps: Math.round(((st.framesRendered - prev.rendered) / dt) * 10) / 10,
      dropped: st.framesDropped - prev.dropped,
      decodeQueue: this._videoDecoder?.decodeQueueSize ?? 0,
      videoQueue: this._videoQueue.length,
      reanchors: st.reanchors || 0,
      inputShed: st.inputShed || 0,
      pausedDrops: st.pausedDrops || 0,
      rebuilds: st.decoderRebuilds || 0,
      software: !!st.softwareFallback,
      visible: this._paneVisible && this._tabVisible,
      rttMs: this._pings.length ? Math.round(Math.min(...this._pings.map((p) => p.rtt))) : null,
      arrival: spread(this._arrivalLags),
      render: spread(this._renderLags),
    };
    this._arrivalLags = [];
    this._renderLags = [];
    try { ws.send(JSON.stringify(report)); } catch { /* closing */ }
  }

  _handleBinary(buf) {
    if (this._stopped) return;  // message arrived after stop(); ignore.
    const view = new DataView(buf);
    if (view.byteLength < 2) return;
    if (view.getUint8(0) !== PROTOCOL_VERSION) {
      this._onError(new Error(`unsupported protocol version ${view.getUint8(0)}`));
      return;
    }
    const type = view.getUint8(1);
    switch (type) {
      case MSG_STREAM_START: this._handleStreamStart(view); break;
      case MSG_VIDEO_CONFIG: this._handleVideoConfig(view); break;
      case MSG_VIDEO_CHUNK:  this._handleVideoChunk(view);  break;
      case MSG_AUDIO_CONFIG: this._handleAudioConfig(view); break;
      case MSG_AUDIO_CHUNK:  this._handleAudioChunk(view);  break;
      case MSG_STREAM_RESET: this._handleStreamReset();     break;
      case MSG_STREAM_ERROR: this._handleStreamError(view); break;
      case MSG_AUDIO_PCM:    this._handleAudioPcm(view);    break;
      case MSG_STREAM_PROBLEM: { const p = parseProblem(view); if (p) this._status('problem', p); break; }
      default: /* unknown type — ignore for forward compat */ break;
    }
  }

  // ── Message handlers ────────────────────────────────────────────────

  _handleStreamStart(/* view */) {
    // Marks the start of a fresh subscription.  Clear any leftover state.
    this._resetPlayoutClock();
    this._videoQueue.forEach(f => f.close());
    this._videoQueue = [];
    // The server is reachable again (the pane drops a "lost connection" cover).
    this._status('subscribed');
  }

  async _handleVideoConfig(view) {
    // Layout:
    //   [2..5]        fourCC (ascii): "avc1" or "hvc1"
    //   [6..7]        codecStringLen (u16 BE)
    //   [8..8+L]      codecString UTF-8
    //   [8+L..11+L]   recordLen (u32 BE)
    //   [12+L..]      record
    const fourCC = String.fromCharCode(view.getUint8(2), view.getUint8(3), view.getUint8(4), view.getUint8(5));
    if (fourCC !== 'avc1' && fourCC !== 'hvc1') {
      this._onError(new Error(`unsupported video codec: ${fourCC}`));
      return;
    }
    const csLen   = view.getUint16(6, false);
    const codec   = new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset + 8, csLen));
    const recOff  = 8 + csLen;
    const recLen  = view.getUint32(recOff, false);
    const record  = new Uint8Array(view.buffer, view.byteOffset + recOff + 4, recLen);

    // Compare the description BYTES, not just the codec string.  "avc1.640028"
    // is identical across resolutions — it encodes profile/compatibility/level
    // and nothing about dimensions — so matching on it alone would skip the
    // rebuild when a camera is re-encoded to a new resolution, leaving the
    // decoder configured for the old frame size and rendering the new stream
    // cropped.  (The server has the matching byte-wise check in h264Parser.)
    const sameCodec  = codec === this._videoCodecString;
    const sameRecord = !!this._videoCodecRecord
      && this._videoCodecRecord.length === record.length
      && record.every((b, i) => b === this._videoCodecRecord[i]);
    if (sameCodec && sameRecord && this._videoDecoder?.state === 'configured') {
      return;  // Identical config — no need to rebuild.
    }
    this._videoCodecString = codec;
    // Cache a copy of the description bytes so we can rebuild the decoder
    // later (e.g. after an off-screen idle close) without needing the
    // server to re-send a VIDEO_CONFIG.  Slice into a fresh Uint8Array
    // because the incoming `record` is a view into the WebSocket message
    // buffer, which becomes invalid after this handler returns.
    this._videoCodecRecord = record.slice();

    // Settle hardware vs software before the first configure.  Chunks that
    // arrive meanwhile (the catch-up GOP, usually) are held and replayed.
    if (!this._hwAccel && typeof VideoDecoder !== 'undefined') {
      this._configPending = true;
      this._pendingChunks = [];
      this._hwAccel = await hardwareModeFor(codec, this._videoCodecRecord);
      this._configPending = false;
      if (this._stopped || this._videoCodecString !== codec) { this._pendingChunks = []; return; }
    }

    if (!this._createVideoDecoder()) { this._pendingChunks = []; return; }
    // A reconfigured decoder has no reference frames — deltas coded against
    // the pre-reconfigure picture are invalid.  Resume from the next
    // keyframe; on initial subscribe the server replays its cached keyframe
    // immediately after the config, so this costs nothing there.
    this._waitingForKeyframe = true;
    this._status('streaming');
    const held = this._pendingChunks || [];
    this._pendingChunks = [];
    for (const v of held) this._handleVideoChunk(v, true);
  }

  /**
   * (Re)create the VideoDecoder from the cached codec string + description.
   * Returns true on success, false on hard failure (e.g. WebCodecs absent).
   * Used both from `_handleVideoConfig` (initial setup) and from the
   * pane-visibility return path after an off-screen close.
   */
  _createVideoDecoder() {
    if (typeof VideoDecoder === 'undefined') {
      this._onError(new Error('VideoDecoder unavailable — WebCodecs requires a secure context (use https:// or http://localhost)'));
      this._status('error', 'WebCodecs unavailable (insecure origin)');
      return false;
    }
    if (!this._videoCodecString || !this._videoCodecRecord) return false;
    if (this._videoDecoder) {
      _decrementActiveDecoderCount();
      try { this._videoDecoder.close(); } catch { /* ignore */ }
    }
    // Chromium implements 'prefer-hardware' as REQUIRE hardware: on a PC with
    // no hardware decoder for this codec (or a VM, or a headless kiosk) every
    // configure fails with "Unsupported configuration".  The first such
    // failure drops this client to 'no-preference' (software allowed).
    const hwAccel = this._hwAccel || 'prefer-hardware';
    const decoder = new VideoDecoder({
      output: (frame) => this._onVideoFrame(frame),
      // WebCodecs error callbacks are fatal — the decoder is dead after
      // one fires.  Without a rebuild the chunk handler silently drops
      // every subsequent chunk (state guard) and the pane freezes forever
      // while the WS keeps streaming.  GPU pressure is the common trigger
      // (hardware decoder evicted / driver reset), so recovery matters
      // most on exactly the machines that hit it.
      error: (err) => {
        if (hwAccel === 'prefer-hardware' && /unsupported configuration|not supported/i.test(err?.message || '')) {
          this._hwAccel = 'no-preference';
          this._stats.softwareFallback = true;
        } else {
          this._onError(err);
        }
        this._scheduleDecoderRebuild();
      },
    });
    try {
      decoder.configure({
        codec:                this._videoCodecString,
        description:          this._videoCodecRecord,
        optimizeForLatency:   true,
        hardwareAcceleration: hwAccel,
      });
    } catch (err) {
      this._onError(new Error(`VideoDecoder.configure failed: ${err.message}`));
      return false;
    }
    this._videoDecoder = decoder;
    _incrementActiveDecoderCount();
    return true;
  }

  /**
   * Recover from a fatal VideoDecoder error: drop the dead decoder now
   * (so the chunk handler stops feeding it) and rebuild from the cached
   * codec config after a short delay.  The 1 s spacing rate-limits the
   * create/destroy cycle if the GPU is so wedged that every rebuild
   * immediately errors again — better a 1 Hz retry than a tight loop
   * hammering the GPU process.
   */
  _scheduleDecoderRebuild() {
    if (this._videoDecoder) {
      _decrementActiveDecoderCount();
      try { this._videoDecoder.close(); } catch { /* already closed by the error */ }
      this._videoDecoder = null;
    }
    if (this._decoderRebuildTimer || this._stopped) return;
    const delay = this._stats.softwareFallback && !this._stats.decoderRebuilds ? 0 : 1_000;
    this._decoderRebuildTimer = setTimeout(() => {
      this._decoderRebuildTimer = null;
      if (this._stopped || this._videoDecoder) return;
      if (this._decodingPaused()) return;  // _syncVisibility rebuilds on return
      if (this._videoCodecRecord && this._createVideoDecoder()) {
        this._waitingForKeyframe = true;
        this._stats.decoderRebuilds = (this._stats.decoderRebuilds || 0) + 1;
      }
    }, delay);
  }

  _handleVideoChunk(view, replayed = false) {
    // Layout:
    //   [2]     flags (bit0 = keyframe)
    //   [3..10] ptsMicros (Int64 LE)
    //   [11..]  AVCC-framed access unit
    if (this._configPending) {
      if (this._pendingChunks.length < 600) {
        this._pendingChunks.push(new DataView(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)));
      }
      return;
    }
    // Arrival delay on the server's clock, for the report (_sendReport).
    if (!replayed && this._clockOffsetMs !== null && !(view.getUint8(2) & FLAG_CATCHUP)
        && this._arrivalLags.length < 3000) {
      this._arrivalLags.push(performance.now() - this._clockOffsetMs - readBigInt64LE(view, 3) / 1000);
    }
    if (!this._videoDecoder || this._videoDecoder.state !== 'configured') return;
    const flags = view.getUint8(2);
    const isKey = (flags & FLAG_KEYFRAME) !== 0;
    const isCatchup = (flags & FLAG_CATCHUP) !== 0;

    // Pause decoding when the tab is hidden OR the pane has scrolled
    // off-screen.  Hidden tabs throttle the GPU decoder hard while WS
    // messages keep arriving at full rate; off-screen panes consume decode
    // budget for output nobody is looking at.  Either way the decoder's
    // input queue would grow unboundedly (multi-GB overnight) if we kept
    // feeding it.  Drop chunks and resume from the next keyframe so the
    // decoder's reference is fresh on return.
    if (this._decodingPaused()) {
      this._waitingForKeyframe = true;
      // Counted, because this branch is otherwise indistinguishable from a
      // healthy pane: the decoder stays 'configured', decodeQueueSize stays 0,
      // the socket stays open, and framesRendered simply stops advancing. A
      // pane latched here (IntersectionObserver reporting off-screen and never
      // reporting back) is frozen permanently — _scheduleDecoderRebuild
      // deliberately gives up while paused and waits for _syncVisibility.
      // Without this counter, "frozen because it thinks nobody is looking" and
      // "frozen because the decoder died" look identical from outside.
      this._stats.pausedDrops = (this._stats.pausedDrops || 0) + 1;
      return;
    }

    // Input-shed when the decoder itself can't keep up.  The pane-level
    // pressure watch handles this for `main` by downgrading to `sub`, but
    // a weak GPU that can't keep up with `sub` has nothing left to shed —
    // without this cap the decode queue grows without bound (memory +
    // GPU-scheduler pressure, and eventually a fatal decoder error).
    // Same GOP-aware trick as the server's broadcast backpressure: drop
    // everything until the next keyframe once the queue passes the
    // threshold, so the decoder never sees a GOP with missing references.
    // 40 chunks ≈ 1.3 s at 30 fps — well past normal jitter.
    if ((this._videoDecoder.decodeQueueSize || 0) > 40) {
      this._waitingForKeyframe = true;
      this._stats.inputShed = (this._stats.inputShed || 0) + 1;
      return;
    }

    if (this._waitingForKeyframe) {
      if (!isKey) return;
      this._waitingForKeyframe = false;
    }

    const pts  = readBigInt64LE(view, 3);
    const data = new Uint8Array(view.buffer, view.byteOffset + 11, view.byteLength - 11);

    // Anchor the playout clock on the first chunk we see — or, for the
    // server's catch-up burst (its cached GOP), on the NEWEST of them, so a
    // late joiner plays from the live edge and the older frames are only
    // decoded as references.
    if (this._anchorServerUs === null || isCatchup) {
      this._anchorServerUs = pts;
      this._anchorPerfMs   = performance.now() + this._bufferMs;
      if (this._audioCtx) {
        this._anchorCtxTime = this._audioCtx.currentTime + this._bufferMs / 1000;
      }
    } else {
      this._guardLatency(pts);
    }

    try {
      this._videoDecoder.decode(new EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        timestamp: pts,
        data,
      }));
    } catch (err) {
      this._onError(err);
    }
  }

  /**
   * Keep the playout clock at the live edge.  `lead` is how long this chunk
   * will wait before it is due; steady state is ≈ bufferMs.  Over a 2 s
   * window take the smallest lead seen (the least-delayed frame is the best
   * estimate of the true live edge):
   *   • much larger than bufferMs → every frame is being held too long
   *     (probe burst at start, camera clock fast) — pull the clock in;
   *   • well below zero → frames arrive after they are due (camera clock
   *     slow) — push it out to restore half a buffer of jitter smoothing.
   */
  _guardLatency(pts) {
    const now = performance.now();
    const lead = this._anchorPerfMs + (pts - this._anchorServerUs) / 1000 - now;
    if (lead < this._leadMin) this._leadMin = lead;
    if (!this._leadWindowStart) this._leadWindowStart = now;
    if (now - this._leadWindowStart < 2000) return;
    const min = this._leadMin;
    this._leadWindowStart = now;
    this._leadMin = Infinity;
    let shift = 0;
    if (min > this._bufferMs + 120) shift = -(min - this._bufferMs);
    else if (min < -250) shift = -min + this._bufferMs / 2;
    if (!shift) return;
    this._anchorPerfMs += shift;
    if (this._audioCtx) this._anchorCtxTime += shift / 1000;
    this._stats.reanchors = (this._stats.reanchors || 0) + 1;
  }

  /**
   * The persistent audio graph: AudioWorkletNode → GainNode → destination.
   * Shared by the Opus and PCM paths; built once per client.
   */
  async _ensureAudioGraph(channels) {
    this._audioCtx = getSharedAudioContext();
    if (!this._audioCtx) return false;
    try {
      await ensureWorkletLoaded(this._audioCtx);
    } catch (err) {
      this._onError(new Error(`AudioWorklet load failed: ${err.message}`));
      return false;
    }
    if (this._stopped) return false;
    if (!this._audioWorklet) {
      this._audioWorklet = new AudioWorkletNode(this._audioCtx, 'claudifer-audio-buffer', {
        numberOfInputs:   0,
        numberOfOutputs:  1,
        outputChannelCount: [channels],
      });
      this._audioWorklet.onprocessorerror = (e) => {
        this._onError(new Error(`worklet processor error: ${e.message || e}`));
      };
      this._audioGain = this._audioCtx.createGain();
      this._audioGain.gain.value = this._muted ? 0 : this._volume;
      this._audioWorklet.connect(this._audioGain).connect(this._audioCtx.destination);
    }
    return true;
  }

  /**
   * AUDIO_PCM — for browsers without AudioDecoder.
   *   [2..9]   ptsMicros (Int64 LE)
   *   [10]     codec (0 = G.711 mu-law)
   *   [11..14] sampleRate (u32 BE)
   *   [15]     channels
   *   [16..]   samples
   */
  async _handleAudioPcm(view) {
    if (this._decodingPaused() || this._muted) return;
    const rate = view.getUint32(11, false);
    const n = view.byteLength - 16;
    if (n <= 0) return;
    const bytes = new Uint8Array(view.buffer, view.byteOffset + 16, n).slice();
    if (!this._audioWorklet) {
      if (this._pcmGraphPending) return;
      this._pcmGraphPending = true;
      const ok = await this._ensureAudioGraph(1);
      this._pcmGraphPending = false;
      if (!ok) return;
    }
    const ctx = this._audioCtx;
    if (!ctx || ctx.state !== 'running' || this._anchorServerUs === null) return;

    // Decode, then linear-resample to the context's rate.  The fractional
    // read position carries across chunks so there is no click at each seam.
    const ratio = rate / ctx.sampleRate;
    const st = this._pcmResample;
    const outLen = Math.floor((n - st.pos) / ratio);
    if (outLen <= 0) return;
    const out = new Float32Array(outLen);
    let pos = st.pos;
    for (let i = 0; i < outLen; i++) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const a = i0 < 0 ? st.last : MULAW_TABLE[bytes[i0]];
      const b = i0 + 1 < n ? MULAW_TABLE[bytes[i0 + 1]] : a;
      out[i] = a + (b - a) * frac;
      pos += ratio;
    }
    st.pos = pos - n;
    st.last = MULAW_TABLE[bytes[n - 1]];
    this._audioWorklet.port.postMessage({ planes: [out] }, [out.buffer]);
    this._stats.audioScheduled++;
  }

  async _handleAudioConfig(view) {
    // Layout:
    //   [2..5]  fourCC, "opus"
    //   [6]     channels
    //   [7..10] sampleRate (u32 BE)
    //   [11..12] preSkip (u16 BE)
    const fourCC     = String.fromCharCode(view.getUint8(2), view.getUint8(3), view.getUint8(4), view.getUint8(5));
    if (fourCC !== 'opus') { this._onError(new Error(`unsupported audio codec: ${fourCC}`)); return; }
    const channels   = view.getUint8(6);
    const sampleRate = view.getUint32(7, false);
    // preSkip is informational — AudioDecoder's Opus implementation handles
    // pre-roll discarding internally when given raw packets.

    if (typeof AudioDecoder === 'undefined') {
      // Safari < 26 (iPad 6th gen included): audio arrives as AUDIO_PCM
      // instead — see _handleAudioPcm.  Nothing to configure here.
      return;
    }

    // Attach to the page-level shared AudioContext and build a persistent
    // node graph:  AudioWorkletNode  →  GainNode  →  destination
    // The worklet receives Float32 PCM via its MessagePort and outputs
    // continuously — no per-packet node creation, no retention leak.
    if (!(await this._ensureAudioGraph(channels))) return;

    // Intentionally NOT calling `_audioCtx.resume()` here.  This handler
    // fires from a WebSocket message — not a user gesture — and Chrome's
    // autoplay policy prints a "The AudioContext was not allowed to start"
    // warning every time `resume()` is called outside a gesture.  With N
    // panes each receiving AUDIO_CONFIG (plus reconnects) that quickly
    // spams the console.  The window-level click/keydown/touchstart unlock
    // listener installed by `getSharedAudioContext` handles resume from a
    // real gesture; until then audio packets are dropped in `_onAudioData`.

    // Source rate must match the shared context rate.  FFmpeg is configured
    // with `-ar 48000` server-side so this should always hold; log if not
    // because pitch will be wrong until that's fixed.
    if (sampleRate !== this._audioCtx.sampleRate) {
      this._onError(new Error(`audio sample rate mismatch: ${sampleRate} vs context ${this._audioCtx.sampleRate}`));
    }
    if (this._stopped) return;

    // (Re)configure AudioDecoder.
    if (this._audioDecoder) { try { this._audioDecoder.close(); } catch {} }
    const decoder = new AudioDecoder({
      output: (data) => this._onAudioData(data),
      error:  (err)  => this._onError(err),
    });
    try {
      decoder.configure({ codec: 'opus', sampleRate, numberOfChannels: channels });
    } catch (err) {
      this._onError(new Error(`AudioDecoder.configure failed: ${err.message}`));
      return;
    }
    this._audioDecoder = decoder;

    // If the video-driven anchor already exists, recalc the audio context anchor.
    if (this._anchorServerUs !== null) {
      const nowPerf = performance.now();
      const leadMs  = this._anchorPerfMs - nowPerf;
      this._anchorCtxTime = this._audioCtx.currentTime + Math.max(0, leadMs / 1000);
    }
  }

  _handleAudioChunk(view) {
    // Layout:
    //   [2..9]   ptsMicros (Int64 LE)
    //   [10..11] packetLen (u16 BE)
    //   [12..]   Opus packet
    if (!this._audioDecoder || this._audioDecoder.state !== 'configured') return;
    // Drop while paused (tab hidden or pane off-screen) — same reasoning as
    // the video path.  Opus packets are independently decodable so we can
    // resume from the very next chunk on return to visibility.
    if (this._decodingPaused()) return;
    const pts  = readBigInt64LE(view, 2);
    const plen = view.getUint16(10, false);
    const data = new Uint8Array(view.buffer, view.byteOffset + 12, plen);

    try {
      this._audioDecoder.decode(new EncodedAudioChunk({
        type: 'key',           // Every Opus packet is independently decodable.
        timestamp: pts,
        data,
      }));
    } catch (err) {
      this._onError(err);
    }
  }

  _handleStreamReset() {
    // Server restarted FFmpeg — decoder state is invalid, wait for fresh
    // config + keyframe.  Also flush the AudioWorklet's internal FIFO so
    // any sub-second of queued samples doesn't keep playing through the
    // gap before fresh Opus packets arrive (otherwise the user hears a
    // brief tail of pre-restart audio after the video has already cut).
    if (this._audioWorklet) {
      try { this._audioWorklet.port.postMessage({ type: 'flush' }); }
      catch { /* worklet already torn down */ }
    }
    this._resetDecoders();
    this._resetPlayoutClock();
    this._status('reconnecting', 'stream reset');
  }

  _handleStreamError(view) {
    const msg = new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset + 2, view.byteLength - 2));
    this._onError(new Error(msg));
    this._status('error', msg);
  }

  // ── Decoder outputs ────────────────────────────────────────────────

  _onVideoFrame(frame) {
    // Insert sorted by timestamp — B-frames can arrive out of display order.
    const q = this._videoQueue;
    const ts = frame.timestamp;
    let i = q.length;
    while (i > 0 && q[i - 1].timestamp > ts) i--;
    q.splice(i, 0, frame);

    // Hard cap: each VideoFrame pins ~3 MB of GPU memory at 1080p, and the
    // rAF drain loop is the only thing that closes them.  If rAF ever stalls
    // (GC pause, background-tab throttling, worker scheduling hiccups), the
    // queue must not be allowed to grow without bound.  60 frames = ~2 s of
    // video at 30 fps — more than enough headroom for normal draining, far
    // less than the thousands that would start eating gigabytes.
    const MAX_QUEUE = 60;
    while (q.length > MAX_QUEUE) q.shift().close();
  }

  _onAudioData(audioData) {
    const ctx = this._audioCtx;
    if (!ctx || this._anchorServerUs === null) {
      audioData.close(); return;
    }
    // The shared AudioContext starts in 'suspended' — nothing plays until
    // the user's first click/keydown/touchstart resumes it.  Drop packets
    // while suspended so we don't pile samples into the worklet queue
    // against a frozen clock.
    if (ctx.state !== 'running' || !this._audioWorklet) {
      audioData.close(); return;
    }

    // No PTS-based late-drop here.  The previous BufferSourceNode design
    // needed it to prevent burst-playback of stale packets, but the worklet
    // is a strict FIFO with a built-in ~1 s queue cap (see
    // audioWorkletProcessor.js MAX_QUEUE_FRAMES).  Any backlog gets bounded
    // there.  Dropping based on `_anchorCtxTime + offset < currentTime - 0.15`
    // is also actively harmful over long uptime: the audio context's sample
    // clock and the server's wall-clock can drift by a few PPM, which adds
    // up past 150 ms after roughly a day — at which point every packet
    // looks late and audio cuts out for every stream simultaneously, only
    // recovering when the client reconnects with a fresh anchor.

    // Extract planar Float32 samples.  Using `finally` so the underlying
    // AudioData is closed even if copyTo throws.
    const channels = audioData.numberOfChannels;
    const frames   = audioData.numberOfFrames;
    const planes   = new Array(channels);
    try {
      for (let c = 0; c < channels; c++) {
        const plane = new Float32Array(frames);
        audioData.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        planes[c] = plane;
      }
    } finally {
      audioData.close();
    }

    // Zero-copy handoff: the Float32Arrays' backing ArrayBuffers are
    // transferred into the worklet's context, so the main thread drops
    // its reference immediately and nothing accumulates here.
    this._audioWorklet.port.postMessage(
      { planes },
      planes.map((p) => p.buffer),
    );
    this._stats.audioScheduled++;
  }

  // ── Playout ────────────────────────────────────────────────────────

  _rafTick() {
    this._rafId = requestAnimationFrame(() => this._rafTick());

    // Sample decoder pressure ~2 Hz (every 30 frames at 60 fps).  Cheap
    // single property read; the rolling window is ~5 s of samples.
    if ((++this._pressureFrameCount % 30) === 0 && this._videoDecoder) {
      this._pressureSamples.push(this._videoDecoder.decodeQueueSize || 0);
      if (this._pressureSamples.length > 10) this._pressureSamples.shift();
    }

    if (this._anchorServerUs === null || this._videoQueue.length === 0) return;
    const nowMs = performance.now();
    if (nowMs < this._anchorPerfMs) return;  // still inside the warmup buffer

    const elapsedMs = nowMs - this._anchorPerfMs;
    const playoutUs = this._anchorServerUs + elapsedMs * 1000;

    // Render the latest frame whose PTS has come due; close any older frames
    // so we don't accumulate lag by drawing stale pictures.
    let toRender = null;
    while (this._videoQueue.length > 0 && this._videoQueue[0].timestamp <= playoutUs) {
      if (toRender) { toRender.close(); this._stats.framesDropped++; }
      toRender = this._videoQueue.shift();
    }
    if (toRender) {
      if (this._clockOffsetMs !== null && this._renderLags.length < 3000) {
        this._renderLags.push(nowMs - this._clockOffsetMs - toRender.timestamp / 1000);
      }
      this._renderer.drawFrame(toRender);
      this._stats.framesRendered++;
      if (!this._firstFrameSent) {
        this._firstFrameSent = true;
        try { this._onFirstFrame(); } catch { /* host callback errors are theirs */ }
      }
    }

    // Hard cap on queue depth: if decoded frames pile up (e.g. decoder bursty),
    // flush anything older than 500 ms past playout.
    const cutoffUs = playoutUs - 500_000;
    while (this._videoQueue.length > 0 && this._videoQueue[0].timestamp < cutoffUs) {
      this._videoQueue.shift().close();
      this._stats.framesDropped++;
    }
  }

  // ── Teardown / reset helpers ──────────────────────────────────────

  _resetDecoders() {
    if (this._videoDecoder) {
      _decrementActiveDecoderCount();
      try { this._videoDecoder.close(); } catch {}
      this._videoDecoder = null;
    }
    if (this._audioDecoder) { try { this._audioDecoder.close(); } catch {} this._audioDecoder = null; }
    // Cached codec config is invalidated alongside the decoder — the server
    // will resend VIDEO_CONFIG after the stream-reset that triggered this.
    // Until then the cached bytes describe an encoding that's about to
    // change, so a wake-from-off-screen rebuild must wait for the new one.
    this._videoCodecString = null;
    this._videoCodecRecord = null;
    for (const f of this._videoQueue) f.close();
    this._videoQueue = [];
  }

  _resetPlayoutClock() {
    this._leadWindowStart = 0;
    this._leadMin = Infinity;
    this._anchorServerUs = null;
    this._anchorPerfMs   = 0;
    this._anchorCtxTime  = 0;
  }

  _tearDown() {
    clearInterval(this._reportTimer);
    this._reportTimer = 0;
    if (this._offScreenIdleTimer) {
      clearTimeout(this._offScreenIdleTimer);
      this._offScreenIdleTimer = null;
    }
    if (this._decoderRebuildTimer) {
      clearTimeout(this._decoderRebuildTimer);
      this._decoderRebuildTimer = null;
    }
    if (this._visibilityListenerAttached) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityListenerAttached = false;
    }
    this._resetDecoders();
    // Do NOT close the shared AudioContext — it's page-lifetime.  Just
    // disconnect this client's audio graph (worklet + gain) so nothing
    // keeps running.
    if (this._audioWorklet) {
      try { this._audioWorklet.port.postMessage({ type: 'flush' }); } catch {}
      try { this._audioWorklet.port.close(); } catch {}
      try { this._audioWorklet.disconnect(); } catch {}
      this._audioWorklet = null;
    }
    if (this._audioGain) {
      try { this._audioGain.disconnect(); } catch { /* already disconnected */ }
      this._audioGain = null;
    }
    this._audioCtx = null;  // drop our reference; the shared ctx lives on
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
    this._renderer?.destroy?.();
  }

  _status(state, detail) {
    try { this._onStatus(state, detail); } catch { /* ignore listener errors */ }
  }
}
