/**
 * msePlayer.js — the fallback decoder for browsers whose WebCodecs can't
 * decode a codec that their <video> element can.
 *
 * Seen on a Windows 10 PC in Chrome: VideoDecoder.isConfigSupported says yes
 * to H.265 in hardware, then every decode fails, while the same stream plays
 * in a <video> element through Media Source Extensions (Chrome takes a
 * different decode path there).  This wraps each access unit the server sends
 * in a one-sample fMP4 fragment, feeds a hidden <video>, and hands its frames
 * back as VideoFrames so the pane's canvas, covers and statistics stay as
 * they are.
 *
 * Timescale is microseconds, the same as the server's PTS, so a fragment's
 * decode time is its PTS and every frame's mediaTime maps straight back.
 */

const TIMESCALE = 1_000_000;

// ─── Box writing ───────────────────────────────────────────────────────

function u8(...b) { return Uint8Array.from(b); }
function u16(v) { return u8(v >>> 8 & 255, v & 255); }
function u32(v) { return u8(v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255); }
function u64(v) { const hi = Math.floor(v / 2 ** 32); return concat(u32(hi), u32(v - hi * 2 ** 32)); }
function str(s) { return Uint8Array.from(s, (c) => c.charCodeAt(0)); }
function zeros(n) { return new Uint8Array(n); }

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function box(type, ...payload) {
  const body = concat(...payload);
  return concat(u32(body.length + 8), str(type), body);
}
function fullBox(type, version, flags, ...payload) {
  return box(type, u8(version, flags >>> 16 & 255, flags >>> 8 & 255, flags & 255), ...payload);
}

const MATRIX = concat(u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000));

/** ftyp + moov for one video track; `record` is the avcC/hvcC payload. */
function initSegment(fourCC, record, width, height) {
  const entry = box(fourCC,
    zeros(6), u16(1),                       // reserved, data_reference_index
    zeros(16),                              // pre_defined / reserved
    u16(width), u16(height),
    u32(0x480000), u32(0x480000), zeros(4), // 72 dpi, reserved
    u16(1), zeros(32),                      // frame_count, compressorname
    u16(0x18), u16(0xffff),                 // depth, pre_defined
    box(fourCC === 'avc1' ? 'avcC' : 'hvcC', record));
  const stbl = box('stbl',
    fullBox('stsd', 0, 0, u32(1), entry),
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)));
  const minf = box('minf',
    fullBox('vmhd', 0, 1, zeros(8)),
    box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
    stbl);
  const mdia = box('mdia',
    fullBox('mdhd', 0, 0, zeros(8), u32(TIMESCALE), u32(0), u16(0x55c4), u16(0)),
    fullBox('hdlr', 0, 0, u32(0), str('vide'), zeros(12), str('video\0')),
    minf);
  const trak = box('trak',
    fullBox('tkhd', 0, 3, zeros(8), u32(1), zeros(4), u32(0), zeros(8), u16(0), u16(0), u16(0), u16(0),
      MATRIX, u32(width << 16), u32(height << 16)),
    mdia);
  const moov = box('moov',
    fullBox('mvhd', 0, 0, zeros(8), u32(TIMESCALE), u32(0), u32(0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(2)),
    trak,
    box('mvex', fullBox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0))));
  return concat(box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso6'), str('mp41')), moov);
}

/** moof + mdat holding one access unit. */
function fragment(seq, pts, duration, isKey, data) {
  const trun = (offset) => fullBox('trun', 0, 0x000701, u32(1), u32(offset),
    u32(duration), u32(data.length), u32(isKey ? 0x02000000 : 0x01010000));
  const moofWith = (offset) => box('moof',
    fullBox('mfhd', 0, 0, u32(seq)),
    box('traf',
      fullBox('tfhd', 0, 0x020000, u32(1)),   // default-base-is-moof
      fullBox('tfdt', 1, 0, u64(pts)),
      trun(offset)));
  const size = moofWith(0).length;
  return concat(moofWith(size + 8), u32(data.length + 8), str('mdat'), data);
}

// ─── Support check ─────────────────────────────────────────────────────

function mseAccepts(codec) {
  try {
    return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(`video/mp4; codecs="${codec}"`);
  } catch { return false; }
}

/**
 * The codec string this browser's <video> accepts for the stream, or null.
 * The server's HEVC strings are exact (e.g. 'hvc1.1.2.L153', no constraint
 * bytes); some Chrome builds may only know the common 'hvc1.1.6.L153.B0'
 * form. The picture comes from the hvcC record either way, so the
 * SourceBuffer may be opened with the common form.
 */
export function mseCodecFor(codec) {
  if (!codec) return null;
  if (mseAccepts(codec)) return codec;
  const m = /^(hvc1|hev1)\.[A-C]?\d+\.[0-9A-F]+\.([LH])(\d+)/i.exec(codec);
  if (!m) return null;
  for (const alt of [`hvc1.1.6.${m[2]}${m[3]}.B0`, `hvc1.1.6.L${m[3]}.B0`, 'hvc1.1.6.L153.B0']) {
    if (mseAccepts(alt)) return alt;
  }
  return null;
}

/** Whether this browser's <video> plays the codec through MSE. */
export function mseSupports(codec) {
  return mseCodecFor(codec) !== null;
}

// ─── Player ────────────────────────────────────────────────────────────

export class MsePlayer {
  /**
   * @param {object} o
   * @param {string} o.fourCC   'avc1' or 'hvc1'
   * @param {string} o.codec    codec string, e.g. 'hvc1.1.6.L93.B0'
   * @param {Uint8Array} o.record  avcC / hvcC payload
   * @param {(frame: VideoFrame) => void} o.onFrame  receives frames (timestamp = server PTS, µs); must close them
   * @param {(err: Error) => void} o.onError
   */
  constructor({ fourCC, codec, record, onFrame, onError }) {
    this._onFrame = onFrame;
    this._onError = onError;
    this._init = initSegment(fourCC, record, 1920, 1080);
    this._codec = mseCodecFor(codec) || codec;
    this._queue = [];          // ArrayBuffers waiting for the SourceBuffer
    this._held = null;         // newest access unit, appended once the next one gives its duration
    this._needKey = true;
    this._seq = 1;
    this._lastDuration = 66_666;
    this._lastPrune = 0;
    this._closed = false;

    // In the page (at 0,0, nearly transparent) rather than detached: Chrome
    // may stop presenting frames of a video that isn't in the document.
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('aria-hidden', 'true');
    v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;';
    document.body.appendChild(v);
    this._video = v;

    this._ms = new MediaSource();
    this._url = URL.createObjectURL(this._ms);
    v.src = this._url;
    this._ms.addEventListener('sourceopen', () => {
      if (this._closed) return;
      try {
        this._sb = this._ms.addSourceBuffer(`video/mp4; codecs="${this._codec}"`);
        this._sb.mode = 'segments';
        this._sb.addEventListener('updateend', () => this._pump());
        this._queue.unshift(this._init);
        this._pump();
      } catch (err) { this._fail(err); }
    }, { once: true });
    v.addEventListener('error', () => this._fail(new Error(`video element: ${v.error && v.error.message || 'decode error'}`)));

    // Frames: requestVideoFrameCallback where there is one, else poll on rAF.
    this._lastMediaTime = -1;
    if ('requestVideoFrameCallback' in v) {
      const cb = (_now, meta) => { if (this._closed) return; this._emit(meta.mediaTime); v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb);
    } else {
      const tick = () => { if (this._closed) return; if (v.readyState >= 2) this._emit(v.currentTime); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }
  }

  /** Whether the next accepted access unit must be a keyframe. */
  needKeyframe() { this._needKey = true; this._held = null; }

  /** One access unit: `pts` in µs, `data` length-prefixed (AVCC framing). */
  push(pts, isKey, data) {
    if (this._closed) return;
    if (this._needKey) {
      if (!isKey) return;
      this._needKey = false;
    }
    const prev = this._held;
    this._held = { pts, isKey, data: data.slice() };
    if (!prev) return;
    let duration = pts - prev.pts;
    if (!(duration > 0 && duration < 2_000_000)) duration = this._lastDuration;
    this._lastDuration = duration;
    this._queue.push(fragment(this._seq++, prev.pts, duration, prev.isKey, prev.data));
    if (this._queue.length > 90) {
      // The SourceBuffer is far behind (it never opened, or the page stalled):
      // start again from the next keyframe instead of growing without bound.
      this._queue = this._sb ? [] : [this._init];
      this.needKeyframe();
      return;
    }
    this._pump();
  }

  /** The video element's own decode counters, for the report. */
  quality() {
    const q = this._video.getVideoPlaybackQuality ? this._video.getVideoPlaybackQuality() : null;
    return q ? { decoded: q.totalVideoFrames, dropped: q.droppedVideoFrames } : null;
  }

  destroy() {
    if (this._closed) return;
    this._closed = true;
    this._queue = [];
    try { this._video.removeAttribute('src'); this._video.load(); } catch { /* ignore */ }
    this._video.remove();
    URL.revokeObjectURL(this._url);
  }

  _pump() {
    const sb = this._sb;
    if (this._closed || !sb || sb.updating) return;
    this._chase();
    const now = performance.now();
    const b = sb.buffered;
    if (now - this._lastPrune > 5000 && b.length && this._video.currentTime - b.start(0) > 10) {
      this._lastPrune = now;
      try { sb.remove(b.start(0), this._video.currentTime - 5); return; } catch { /* append instead */ }
    }
    const next = this._queue.shift();
    if (!next) return;
    try { sb.appendBuffer(next); } catch (err) {
      if (err && err.name === 'QuotaExceededError') { this._queue = []; this.needKeyframe(); return; }
      this._fail(err);
    }
  }

  /**
   * Stay at the live edge: start at the first buffered frame, jump forward
   * when more than half a second is buffered ahead (a stalled tab, a burst),
   * and keep the element playing.
   */
  _chase() {
    const v = this._video, b = this._sb.buffered;
    if (!b.length) return;
    const end = b.end(b.length - 1);
    if (v.currentTime < b.start(0) || end - v.currentTime > 0.5) {
      try { v.currentTime = Math.max(b.start(b.length - 1), end - 0.1); } catch { /* not seekable yet */ }
    }
    if (v.paused) v.play().catch(() => { /* muted, so allowed; retried on the next append */ });
  }

  _emit(mediaTime) {
    if (mediaTime === this._lastMediaTime) return;
    this._lastMediaTime = mediaTime;
    let frame;
    try { frame = new VideoFrame(this._video, { timestamp: Math.round(mediaTime * TIMESCALE) }); } catch { return; }
    this._onFrame(frame);
  }

  _fail(err) {
    if (this._closed) return;
    this._onError(err);
  }
}
