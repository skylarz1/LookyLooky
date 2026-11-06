/**
 * Claudifer Viewer — CameraPane & CameraGrid (WebCodecs edition), LookyLooky
 *
 * Self-contained ES Module.  A camera pane runs in one of two tiers: a
 * WebSocket-backed WebCodecs client decoding H.264/HEVC + Opus in the
 * browser (full-motion), or an MJPEG <img> thumbnail for panes over the
 * per-client decode budget (see computeFullMotionSet).  No HLS, no WebRTC.
 *
 * Usage:
 *   import { CameraGrid } from '/js/camera/viewer.js';
 *   const grid = new CameraGrid({ container: document.getElementById('g') });
 *   grid.buildHoverControls = (cam, slotIndex) => '...';
 *   grid.buildEmptySlot     = (slotIndex)      => '...';
 *   grid.setLayout(layout, cameras);
 *
 * Layout slots are still `{ cameraId, streamType }` shaped for backward
 * compatibility with persisted configs, but `streamType` is ignored — every
 * pane uses WebCodecs.
 *
 * Zoom: mouse wheel (zooms toward the cursor) or pinch on a touch screen;
 * drag / one finger pans while zoomed.  A pane's zoom resets when it moves to
 * another position (featured swap, drag-drop, wall selection).
 *
 * Stream quality (main = High, sub = Low) is decided per pane, in this order:
 *   1. decoder overload — forced Low (amber variant tag)
 *   2. the pane's own HQ/LQ button (grid.setPaneQuality)
 *   3. the view's override (grid.setQualityOverride)
 *   4. the server policy (grid.qualityPolicy): 'sub' (always Low — the
 *      default), 'fullscreen' (High only fullscreen / 1x1), 'large' (also High
 *      when the pane is at least mainMinWidth device pixels wide), 'main'.
 *
 * Audio: one FOCUSED pane follows the page's master mute / volume (the
 * dashboard's top speaker button, the wall's main pane).  Each pane also has
 * its own speaker button, which adds that camera on top — any number at
 * once, at the master volume, whatever the master mute says.  Muting the
 * master silences everything and clears those extras.
 *
 * LookyLooky additions: `fullMotion: false` builds a thumbnail-only grid for
 * browsers without WebCodecs (an insecure origin, an old browser), so the
 * board degrades to JPEG panes instead of going black; CameraGrid.destroy();
 * camera names are HTML-escaped in the pane template.
 */

import { WebCodecsClient, ThumbnailClient, CanvasVideoRenderer, ensureSharedAudioContext } from './webcodecsClient.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** True when this browser can run the full-motion tier at all. */
export function webCodecsAvailable() {
  return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
}

// How long the outgoing render tier keeps painting while the incoming one
// warms up.  A promoted pane waits on an RTSP connect plus the camera's next
// keyframe — camera-side, commonly 1–4 s and not shortenable — so tearing the
// old picture down first blacks the pane out for that whole window.  Past
// this ceiling we assume the incoming tier isn't coming and swap anyway.
const BRIDGE_MAX_MS = 8000;

// ─── Full-motion decode budget ─────────────────────────────────────────
/**
 * Decide which panes get a full-motion WebCodecs pipeline; the rest render
 * as MJPEG <img> thumbnails.  Client decode cost scales linearly with pane
 * count while GPU decode slots are fixed (~4–8), so past the budget extra
 * decoders just starve each other.
 *
 * Pure function (exported for tests).
 * @param {Array<{id:string, area:number, pinned:boolean, slot:number}>} entries —
 *   one per candidate pane; `area` = rendered px², `pinned` = must be
 *   full-motion (browser-fullscreen pane, audio-focal pane), `slot` = stored
 *   slot index, used as a deterministic tiebreak.
 * @param {number} budget — max full-motion panes.  Pinned panes are always
 *   included even if they alone exceed it (at most 2 in practice).
 * @param {Array<string>} prevIds — ids currently full-motion.  Incumbents
 *   get a 25% area bonus as hysteresis: a pane at the budget boundary keeps
 *   its slot against a same-sized challenger, and only yields to one that
 *   is clearly larger.  Prevents mode-flapping when two panes' rendered
 *   sizes differ by rounding noise.
 *
 *   Hysteresis is deliberately NOT applied between panes of exactly equal
 *   area — i.e. across a uniform grid.  There, the bonus isn't damping noise
 *   (there is none), it's just making incumbency permanent: every pane the
 *   user focuses gets promoted and then outranks its identical neighbours
 *   forever, so the full-motion set silently accumulates and un-focusing a
 *   pane never returns it to the thumbnail tier.  Equal areas fall back to
 *   slot order, which is stable and predictable.
 * @returns {Set<string>} ids that should run full-motion.
 */
export function computeFullMotionSet(entries, budget, prevIds = []) {
  const prev = new Set(prevIds || []);
  const K = Math.max(0, Math.floor(budget) || 0);
  const HYSTERESIS = 1.25;

  const pinned = [];
  const rest   = [];
  for (const e of entries || []) (e.pinned ? pinned : rest).push(e);

  rest.sort((a, b) => {
    const aArea = a.area || 0;
    const bArea = b.area || 0;
    if (aArea === bArea) return (a.slot ?? 0) - (b.slot ?? 0);
    return bArea * (prev.has(b.id) ? HYSTERESIS : 1) -
           aArea * (prev.has(a.id) ? HYSTERESIS : 1);
  });

  const chosen = new Set(pinned.map((e) => e.id));
  for (const e of rest) {
    if (chosen.size >= K) break;
    chosen.add(e.id);
  }
  return chosen;
}

// ─── Featured-slot display order ───────────────────────────────────────
/**
 * Map display positions to stored slot indices for a featured layout.
 *
 * Featured layouts ('6f', '13f', …) style their large panel by DOM position
 * — `.camera-card:first-child` / `:nth-child(5)` — so moving a pane into the
 * large panel is purely a matter of reordering children.  That lets the
 * focused camera occupy the big panel without touching `layout.slots`: the
 * stored layout stays exactly as the operator saved it, and only drag-drop
 * ever mutates it.
 *
 * Pure function (exported for tests).
 * @param {number} slotCount      total slots in the layout
 * @param {number|null} featuredSlot   index of the large panel, or null when
 *   the layout has no featured slot (plain grids like 2x2 / 4x4)
 * @param {number|null} tempFocusSlot  stored slot whose camera should appear
 *   in the large panel, or null for the layout's natural order
 * @returns {number[]} `order[displayPosition] = storedSlotIndex`
 */
export function computeDisplayOrder(slotCount, featuredSlot, tempFocusSlot) {
  return computeMultiDisplayOrder(slotCount, [[featuredSlot, tempFocusSlot]]);
}

/**
 * Same, for layouts with more than one large panel (e.g. '10d', which has two
 * side by side).  Each zone owns one swap, so the left half can hold a
 * promoted camera while the right half is untouched.
 *
 * Overlapping pairs are skipped rather than merged: two exchanges sharing a
 * position would make "where is stored slot i on screen?" ambiguous and could
 * duplicate or drop a pane.  Skipping keeps the output a permutation no matter
 * what it is handed.
 *
 * Pure function (exported for tests).
 * @param {number} slotCount
 * @param {Array<[number,number]>} swaps  [featuredSlot, tempFocusSlot] pairs
 * @returns {number[]} `order[displayPosition] = storedSlotIndex`
 */
export function computeMultiDisplayOrder(slotCount, swaps) {
  const n = Math.max(0, Math.floor(slotCount) || 0);
  const order = [];
  for (let i = 0; i < n; i++) order.push(i);
  if (!Array.isArray(swaps)) return order;

  const touched = new Set();
  for (const pair of swaps) {
    if (!Array.isArray(pair)) continue;
    const [f, t] = pair;
    if (!Number.isInteger(f) || !Number.isInteger(t)) continue;
    if (f === t) continue;
    if (f < 0 || f >= n || t < 0 || t >= n) continue;
    if (touched.has(f) || touched.has(t)) continue;
    touched.add(f); touched.add(t);
    order[f] = t;
    order[t] = f;
  }
  return order;
}

/**
 * Normalise a layout def's featured configuration into zones.
 *
 * Two shapes are accepted:
 *   `featured: N`                 one large panel; every slot promotes into it
 *   `features: [...]` + `featureOf: [...]`  several large panels, with
 *     `featureOf[storedSlot]` naming which one that slot promotes into
 *
 * `featureOf` is indexed by STORED slot and is therefore static — it does not
 * change as panes are swapped around, which is what keeps the zone of a click
 * unambiguous while a swap is already live.
 *
 * Pure function (exported for tests).
 * @returns {{features:number[], featureOf:number[]}|null} null for plain grids
 */
export function featureZonesOf(def, slotCount) {
  if (!def) return null;
  const n = Math.max(0, Math.floor(slotCount) || 0);
  const inRange = (i) => Number.isInteger(i) && i >= 0 && i < n;

  if (Array.isArray(def.features) && def.features.length) {
    const features = def.features.filter(inRange);
    if (!features.length) return null;
    const declared = Array.isArray(def.featureOf) ? def.featureOf : null;
    const featureOf = [];
    for (let i = 0; i < n; i++) {
      const v = declared ? declared[i] : undefined;
      // An unmapped or bogus slot falls back to the first feature rather than
      // becoming unclickable.
      featureOf[i] = features.includes(v) ? v : features[0];
    }
    // A large panel always belongs to itself, so clicking the camera already
    // up there restores that zone instead of swapping it with a sibling.
    for (const f of features) featureOf[f] = f;
    return { features, featureOf };
  }

  if (inRange(def.featured)) {
    const f = def.featured;
    return { features: [f], featureOf: Array.from({ length: n }, () => f) };
  }
  return null;
}

// ─── CameraPane ────────────────────────────────────────────────────────
/**
 * Owns one camera slot: builds its HTML, manages the WebCodecs client, and
 * forwards pane-level UI events (focus / drag / dblclick) to the parent grid.
 */
export class CameraPane {
  /**
   * @param {object}  opts
   * @param {string}  opts.cameraId
   * @param {object}  opts.camera         — status row from GET /api/cameras
   * @param {number}  opts.slotIndex
   * @param {string}  [opts.wsUrl]        — override; defaults to current host
   * @param {string}  [opts.idPrefix]     — DOM ID prefix for multi-grid pages
   * @param {boolean} [opts.isFocalStream]
   * @param {number}  [opts.bufferMs]
   */
  constructor({ cameraId, camera, slotIndex, wsUrl, idPrefix = '', isFocalStream = false, bufferMs = 150, mode = 'webcodecs', interactive = true }) {
    this.cameraId      = cameraId;
    // A non-interactive pane is drag-inert and binds no pointer handlers —
    // for read-only boards (view.html) where a stray drag is pure noise.
    this.interactive   = interactive;
    this.camera        = camera;
    this.slotIndex     = slotIndex;
    this.idPrefix      = idPrefix;
    this.isFocalStream = isFocalStream;
    this._bufferMs     = bufferMs;
    this._wsUrl        = wsUrl || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;

    // Render tier: 'webcodecs' = full-motion decode pipeline; 'thumbnail' =
    // MJPEG <img> (no WS, no decoder, no audio) for panes over the grid's
    // full-motion budget.  Switched via setMode() by the grid's re-rank.
    this.mode = mode;

    // `_client` is whatever is currently on screen (either tier); `_incoming`
    // is a replacement warming up on the other canvas layer.  Both run briefly
    // during any transition so the outgoing picture stays visible until the
    // new one has actually painted — see _transitionTo / _onIncomingReady.
    this._client      = null;
    this._incoming    = null;
    this._activeLayer = 0;
    this._bridgeTimer = null;
    this._pendingMode    = null;
    this._pendingQuality = null;
    this._paneVisible    = true;
    this._currentQuality        = null;  // variant currently subscribed to
    this._intersectionObserver  = null;
    this._pressureInterval      = null;
    this._fullscreenHandler     = null;

    // Adaptive variant state: when the client's decoder backs up for a
    // sustained window we force this pane down to sub (overriding both the
    // layout preference and the size-based pick).  After a sustained calm
    // period the flag clears and the pane attempts to re-pick whatever it
    // would naturally want.  Anti-flap timer prevents rapid oscillation.
    this._pressureDowngrade = false;
    this._pressureSince     = 0;
    this._healthySince      = 0;
    this._lastUpshiftTime   = 0;

    // Optional callback set by the parent grid: `(slotIndex) => 'main' | null`.
    // When it returns 'main', the pane treats itself as fullscreen for
    // variant-picking purposes (used for the 1x1 layout — a single visible
    // pane is effectively dashboard-fullscreen).  Otherwise we fall back
    // to actual browser fullscreen detection.
    this.getLayoutPreferredVariant = null;

    // The grid this pane belongs to (quality policy and overrides live there).
    this.grid = null;

    // Zoom, as scale and the top-left offset in FRACTIONS of the pane's size,
    // so a resize (fullscreen, window) keeps the same picture region.
    this._zoom = { s: 1, x: 0, y: 0 };
    this._suppressClick = false;

    // Callbacks populated by CameraGrid or host page
    this.onFocusRequest = null;
    this.onDblClick     = null;
    this.onDragStart    = null;
    this.onDragEnd      = null;
    this.onDragOver     = null;
    this.onDrop         = null;
    this.onDragLeave    = null;
  }

  // ── Element ID helpers ────────────────────────────────────────────
  get cardId()       { return `${this.idPrefix}card-${this.cameraId}`; }
  get videoWrapId()  { return `${this.idPrefix}video-${this.cameraId}`; }
  get hoverCtrlId()  { return `${this.idPrefix}hc-${this.cameraId}`; }
  get canvasId()      { return `${this.idPrefix}cv-${this.cameraId}`; }
  get thumbCanvasId() { return `${this.idPrefix}tc-${this.cameraId}`; }
  get loadingId()    { return `${this.idPrefix}loading-${this.cameraId}`; }
  get statusId()     { return `${this.idPrefix}stream-status-${this.cameraId}`; }
  get variantTagId() { return `${this.idPrefix}vt-${this.cameraId}`; }
  get zoomBadgeId()  { return `${this.idPrefix}zb-${this.cameraId}`; }
  get qualityCtlId() { return `${this.idPrefix}qc-${this.cameraId}`; }
  get speakerBtnId() { return `${this.idPrefix}sp-${this.cameraId}`; }
  get element()      { return document.getElementById(this.cardId); }

  // ── HTML construction ─────────────────────────────────────────────

  /** Inner HTML for the `.video-wrap` element.  Swapped in-place on status
   *  transitions so the outer card + wrap + overlay + hover-controls stay
   *  mounted and keep their event listeners and hover state. */
  _innerHTML() {
    const { camera: cam, slotIndex: idx } = this;
    // Both tiers render to a <canvas>; only what feeds it differs.  The
    // thumbnail tier used to be an <img> pointed at /stream/:id/mjpeg, but
    // that holds an HTTP/1.1 connection open per pane against a six-per-origin
    // browser cap — past six thumbnails the extra panes stayed black and the
    // dashboard's own /api polling starved behind them.  JPEG frames now
    // arrive over the same WebSocket the video tier uses (see ThumbnailClient).
    // Two stacked canvases, one per tier.  Both are always mounted so a tier
    // switch is a visibility flip rather than a DOM rebuild — which is what
    // lets the outgoing picture stay up until the incoming feed has actually
    // painted.  Switching focus otherwise blacks out two panes at once: the
    // promoted one waits on an RTSP connect plus the camera's next keyframe
    // (1–4 s, camera-side and not shortenable), and the demoted one waits on
    // its MJPEG process to spawn.
    const LAYER = 'position:absolute;inset:0;width:100%;height:100%;background:#000;';
    const content = cam.status !== 'running'
      ? `<div class="placeholder">${cam.status === 'error' ? 'Stream Error' : 'Stream Stopped'}</div>`
      : `<div class="stream-loading" id="${this.loadingId}"></div>
         <canvas id="${this.thumbCanvasId}" style="${LAYER}display:none;"></canvas>
         <canvas id="${this.canvasId}"      style="${LAYER}display:none;"></canvas>
         <div id="${this.statusId}"
              style="position:absolute;top:8px;left:8px;font-size:11px;
                     background:rgba(0,0,0,0.6);color:#fff;padding:2px 8px;
                     max-width:calc(100% - 16px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
                     border-radius:4px;pointer-events:none;z-index:2;">Connecting…</div>
         <button type="button" class="zoom-badge" id="${this.zoomBadgeId}" title="Reset zoom" style="display:none;"></button>
         <button type="button" class="speaker-btn" id="${this.speakerBtnId}" style="display:none;"></button>
         <div class="quality-ctl" id="${this.qualityCtlId}" style="display:none;">
           <button type="button" class="quality-btn" data-q="toggle"></button><button type="button" class="quality-auto" data-q="auto" title="Back to automatic quality">A</button>
         </div>`;

    return `
      ${content}
      <div class="name-overlay">
        <span class="slot-num">${idx + 1}</span>
        <span class="cam-label">${esc(cam.name)}</span>
        <span class="status-dot ${cam.status === 'running' && cam.lastError ? 'error' : cam.status}"
              title="${cam.lastError ? String(cam.lastError).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`) : ''}"></span>
        <span class="variant-tag" id="${this.variantTagId}"></span>
      </div>
      <div class="hover-controls" id="${this.hoverCtrlId}"></div>`;
  }

  buildHTML() {
    const { isFocalStream } = this;
    // `controls-pinned` is on by default — the pane hasn't reached the
    // 'streaming' state yet, so the hover-only control bar would otherwise
    // be unreachable on a stuck-loading stream.  `_onStatus` removes the
    // class once the first frame renders and re-adds it on disconnect/error.
    return `
      <div class="camera-card controls-pinned${isFocalStream ? ' focal-stream' : ''}"
           id="${this.cardId}"${this.interactive ? ' draggable="true"' : ''}>
        <div class="video-wrap" id="${this.videoWrapId}">
          ${this._innerHTML()}
        </div>
      </div>`;
  }

  bind(hoverHTML = '') {
    const el   = this.element;
    const wrap = document.getElementById(this.videoWrapId);
    const hcEl = document.getElementById(this.hoverCtrlId);
    if (!el) return;
    if (hcEl && hoverHTML) hcEl.innerHTML = hoverHTML;
    if (wrap) {
      // After a pan or pinch, the click that ends it must not also select the pane.
      wrap.addEventListener('click', (e) => {
        if (this._suppressClick) { this._suppressClick = false; e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault(); }
      }, true);
      this._bindZoom(wrap, el);
      this._bindQuality(wrap, el);
      this._bindSpeaker(wrap);
      wrap.addEventListener('click',    ()  => this.onFocusRequest?.(this.cameraId));
      wrap.addEventListener('dblclick', (e) => this.onDblClick?.(this.slotIndex, e));
    }
    el.addEventListener('dragstart', (e) => this.onDragStart?.(this.slotIndex, e));
    el.addEventListener('dragend',   (e) => this.onDragEnd?.(e));
    el.addEventListener('dragover',  (e) => this.onDragOver?.(this.slotIndex, e));
    el.addEventListener('drop',      (e) => this.onDrop?.(this.slotIndex, e));
    el.addEventListener('dragleave', (e) => this.onDragLeave?.(e));
  }

  // ── Stream lifecycle ──────────────────────────────────────────────
  //
  // The pane's two stacked canvases are a DOUBLE BUFFER, not fixed
  // video/thumbnail roles.  Anything warming up renders to the inactive
  // layer, and the pane flips only once it has actually painted.  That makes
  // one code path cover every transition that used to black the pane out:
  //   • thumbnail → full motion  (focus / re-rank)
  //   • full motion → thumbnail  (losing focus)
  //   • sub → main and back      (fullscreen enter/exit, layout re-pick)
  //   • resync                   (returning from a hidden tab)
  // The sub↔main case is why roles can't be fixed: bridging between two
  // WebCodecs streams needs two video canvases, not a video and a thumbnail.

  /** Canvas element id backing layer 0 / layer 1. */
  _layerCanvasId(layer) { return layer === 0 ? this.canvasId : this.thumbCanvasId; }

  /**
   * The tier this pane is heading for.  `this.mode` deliberately lags during a
   * transition — it describes what's ON SCREEN, which is still the old tier
   * until the incoming layer paints.  Anything deciding what the pane SHOULD
   * be doing must read this instead, or it will act on a stale answer and
   * cancel the in-flight transition.
   */
  get effectiveMode() { return this._incoming ? this._pendingMode : this.mode; }

  /** Likewise for the variant: the one being switched to, if a switch is in
   *  flight, else the one currently subscribed. */
  get effectiveQuality() { return this._incoming ? this._pendingQuality : this._currentQuality; }

  startStream(audioState) {
    // Cache the caller's audio state so we can restart with the same focal
    // and volume settings after a status-driven content rebuild (e.g. when
    // the user clicks Play on a stopped pane).
    this._audioSnapshot = audioState || this._audioSnapshot || null;

    if (this.camera.status !== 'running') return;
    if (this._client || this._incoming) return;

    this._activeLayer = 0;
    this._currentQuality = this.mode === 'thumbnail' ? null : this._pickVariant();
    const client = this._buildClient(this.mode, this._currentQuality, 0, /* silent */ false);
    if (!client) return;
    this._client = client;
    this._client.start();
    this._showLayer(0);
    this._updateVariantTag();
    this._syncWatchers();
  }

  /** Show exactly one layer.  The other keeps its last painted image but is
   *  hidden, so a flip back is instant. */
  _showLayer(layer) {
    for (const i of [0, 1]) {
      const el = document.getElementById(this._layerCanvasId(i));
      if (el) el.style.display = i === layer ? 'block' : 'none';
    }
  }

  /**
   * Construct (but don't start) a client of `mode` rendering into `layer`.
   * `silent` suppresses status callbacks — an incoming client must not
   * overwrite the pane's visible status with 'connecting…' while the
   * outgoing one is still showing a picture.
   */
  _buildClient(mode, quality, layer, silent) {
    const canvas = document.getElementById(this._layerCanvasId(layer));
    if (!canvas) return null;
    const onStatus     = (state, detail) => { if (!silent) this._onStatus(state, detail); };
    const onFirstFrame = () => this._onIncomingReady(layer);

    if (mode === 'thumbnail') {
      return new ThumbnailClient({
        wsUrl: this._wsUrl, cameraId: this.cameraId, canvas, onStatus, onFirstFrame,
      });
    }

    const audio  = this._audioSnapshot;
    const isFocal = audio?.focal === this.cameraId;
    return new WebCodecsClient({
      wsUrl:    this._wsUrl,
      cameraId: this.cameraId,
      quality,
      renderer: new CanvasVideoRenderer(canvas),
      bufferMs: this._bufferMs,
      muted:    this.grid ? !this.grid.isPaneAudible(this.cameraId) : (isFocal ? (audio?.muted ?? false) : true),
      volume:   audio?.volume ?? 1,
      onStatus,
      onFirstFrame,
      onError:  (err) => console.warn(`[${this.cameraId}]`, err),
      // Server kicked us as a slow consumer (WS hard cap).  Retrying at the
      // same bitrate usually just repeats the kick, so treat it like a
      // decoder-pressure trip and force sub immediately.  If we're already on
      // sub there's nothing left to shed and the client's backoff paces it.
      onKicked: () => {
        if (!this._pressureDowngrade) {
          this._pressureDowngrade = true;
          this._lastUpshiftTime   = performance.now();  // block upshift for the anti-flap window
          this._updateVariantTag();
          this._maybeSwitchVariant();
        }
      },
    });
  }

  /**
   * Bring up `mode`/`quality` on the inactive layer, keeping the current
   * picture on screen until it paints.  The newest request wins: an in-flight
   * transition is discarded rather than queued, so rapid clicking doesn't
   * stack half-built pipelines.
   */
  _transitionTo(mode, quality) {
    if (this.camera.status !== 'running') return;
    if (this._incoming) {
      try { this._incoming.stop(); } catch { /* ignore */ }
      this._incoming = null;
    }
    // Nothing on screen to bridge from — just start directly.
    if (!this._client) {
      this.mode = mode;
      this._currentQuality = quality;
      this.startStream(this._audioSnapshot);
      return;
    }
    const layer  = 1 - this._activeLayer;
    const client = this._buildClient(mode, quality, layer, /* silent */ true);
    if (!client) return;
    this._pendingMode    = mode;
    this._pendingQuality = quality;
    this._incoming       = client;
    client.start();
    // Both feeds are live for the moment — keep visibility gating on the
    // incoming one too, or a scrolled-off pane decodes frames nobody sees.
    this._incoming.setPaneVisible?.(this._paneVisible !== false);
    this._armBridgeTimer();
  }

  /** The incoming client painted — flip to it and retire the outgoing one. */
  _onIncomingReady(layer) {
    if (!this._incoming) return;
    if (layer !== 1 - this._activeLayer) return;  // stale callback from a superseded attempt
    this._clearBridgeTimer();
    const outgoing = this._client;
    this._client         = this._incoming;
    this._incoming       = null;
    this._activeLayer    = layer;
    this.mode            = this._pendingMode;
    this._currentQuality = this._pendingQuality;
    this._showLayer(layer);
    if (outgoing) { try { outgoing.stop(); } catch { /* ignore */ } }
    this._updateVariantTag();
    this._syncWatchers();
  }

  /**
   * Fail-safe: if the incoming client never paints (camera offline, RTSP
   * refused), stop paying for two pipelines and let the pane fall back to its
   * own connecting/error state rather than showing a frozen old picture.
   */
  _armBridgeTimer() {
    this._clearBridgeTimer();
    this._bridgeTimer = setTimeout(() => {
      this._bridgeTimer = null;
      if (this._incoming) this._onIncomingReady(1 - this._activeLayer);
    }, BRIDGE_MAX_MS);
  }

  _clearBridgeTimer() {
    if (this._bridgeTimer) { clearTimeout(this._bridgeTimer); this._bridgeTimer = null; }
  }

  /** Pressure and fullscreen watchers only apply to the video tier. */
  _syncWatchers() {
    this._setupIntersectionObserver();
    if (this.mode === 'webcodecs') {
      this._setupPressureWatch();
      this._setupFullscreenWatch();
    } else {
      this._teardownPressureWatch();
      this._teardownFullscreenWatch();
    }
  }

  _stopClients() {
    this._clearBridgeTimer();
    for (const c of [this._client, this._incoming]) {
      if (c) { try { c.stop(); } catch { /* ignore */ } }
    }
    this._client   = null;
    this._incoming = null;
    this._teardownPressureWatch();
    this._teardownFullscreenWatch();
  }

  /**
   * Pick which variant to subscribe to.  Simple rule: only a fullscreen
   * pane gets `main`; everything else gets `sub`.
   *
   * "Fullscreen" means either:
   *   • Browser fullscreen API on this pane's card, or
   *   • The dashboard's layout has only one slot (the `1x1` view), so
   *     this pane is filling the whole grid.
   *
   * Pressure-downgrade still takes precedence — if the decoder is bogged
   * under main, we force sub even in fullscreen.
   *
   * @param {boolean} [ignorePressure] — set true when probing "what would
   *   we pick if the decoder weren't under load?" (used by the upshift
   *   recovery logic).
   */
  _pickVariant(ignorePressure = false) {
    const variants = this.camera?.variants;
    if (!Array.isArray(variants) || variants.length === 0) return null;  // server default
    if (variants.length === 1) return variants[0].label;

    const labels = new Set(variants.map((v) => v.label));

    // Pressure downgrade: decoder can't keep up with main, force sub.
    if (!ignorePressure && this._pressureDowngrade && labels.has('sub')) return 'sub';

    const has = (q) => labels.has(q);
    const fallback = has('sub') ? 'sub' : 'main';

    // Manual choices: this pane's HQ/LQ button, then the view's override.
    const manual = this.grid?.paneQuality(this.cameraId) || this.grid?.qualityOverride || null;
    if (manual && has(manual)) return manual;

    // The server's policy.  "Fullscreen" means the browser fullscreen API on
    // this pane, or a single-slot layout (getLayoutPreferredVariant → 'main').
    const policy = this.grid?.qualityPolicy || 'sub';
    if (policy === 'main') return has('main') ? 'main' : fallback;
    if (policy === 'sub') return fallback;
    const browserFs = document.fullscreenElement === this.element;
    const layoutFs  = this.getLayoutPreferredVariant?.(this.slotIndex) === 'main';
    if ((browserFs || layoutFs) && has('main')) return 'main';
    if (policy === 'large' && has('main')) {
      const w = this.element?.getBoundingClientRect?.().width || 0;
      if (w * (window.devicePixelRatio || 1) >= (this.grid?.mainMinWidth || 1280)) return 'main';
    }
    return fallback;
  }

  /** Listen for browser fullscreen enter/exit so the variant flips to
   *  main when the user clicks the per-pane fullscreen button, and back
   *  to sub when they exit.  `fullscreenchange` fires globally on the
   *  document for every transition. */
  _setupFullscreenWatch() {
    this._teardownFullscreenWatch();
    this._fullscreenHandler = () => this._maybeSwitchVariant();
    document.addEventListener('fullscreenchange', this._fullscreenHandler);
  }

  _teardownFullscreenWatch() {
    if (this._fullscreenHandler) {
      document.removeEventListener('fullscreenchange', this._fullscreenHandler);
      this._fullscreenHandler = null;
    }
  }

  /** Per-pane visibility: chunks stop flowing into the decoder when the
   *  card scrolls fully out of view (e.g. behind a collapsed sidebar or
   *  long grid).  Saves decode/GPU budget for visible panes.
   *
   *  Timing note: this runs from `startStream`, which the grid calls via
   *  `setTimeout(() => pane.startStream(this._audio), 0)` AFTER the new
   *  `innerHTML` has been written to the container.  That setTimeout is
   *  load-bearing — without it `this.element` is null at observer setup,
   *  and the first IntersectionObserver callback would never fire.  If
   *  you ever inline that scheduling, you'll need to defer this setup
   *  some other way.
   */
  _setupIntersectionObserver() {
    if (typeof IntersectionObserver === 'undefined') return;
    this._teardownIntersectionObserver();
    const el = this.element;
    if (!el) return;
    this._intersectionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        // Both the visible and the warming-up client need this during a
        // transition — otherwise a scrolled-off pane decodes for nobody.
        this._paneVisible = entry.isIntersecting;
        this._client?.setPaneVisible?.(entry.isIntersecting);
        this._incoming?.setPaneVisible?.(entry.isIntersecting);
      }
    }, { threshold: 0 });
    this._intersectionObserver.observe(el);
  }

  _teardownIntersectionObserver() {
    if (this._intersectionObserver) {
      try { this._intersectionObserver.disconnect(); } catch { /* ignore */ }
      this._intersectionObserver = null;
    }
  }

  /** Periodically inspect decoder pressure; auto-downgrade to sub when the
   *  decoder is consistently backed up, auto-upshift after sustained calm.
   *  Self-balances multiple panes against a shared GPU: as soon as one pane
   *  steals enough decoder time to bog down another, the bogged pane drops
   *  to sub and frees the budget back up. */
  _setupPressureWatch() {
    this._teardownPressureWatch();
    this._pressureSince = 0;
    this._healthySince  = 0;
    this._pressureInterval = setInterval(() => this._checkPressure(), 1000);
  }

  _teardownPressureWatch() {
    if (this._pressureInterval) {
      clearInterval(this._pressureInterval);
      this._pressureInterval = null;
    }
  }

  _checkPressure() {
    if (!this._client) return;
    const pressure = this._client.getDecoderPressure();
    const now = performance.now();

    // Three zones: pressured (> 20 queued chunks), healthy (< 3), middle.
    // We require the condition to hold for a sustained window before acting
    // so a brief motion burst doesn't trigger a variant flip.
    if (pressure > 20) {
      this._healthySince = 0;
      if (!this._pressureSince) this._pressureSince = now;
      if (!this._pressureDowngrade && now - this._pressureSince > 3000) {
        this._pressureDowngrade = true;
        this._lastUpshiftTime   = 0;
        this._updateVariantTag();
        this._maybeSwitchVariant();
      }
    } else if (pressure < 3) {
      this._pressureSince = 0;
      if (!this._healthySince) this._healthySince = now;
      if (this._pressureDowngrade && now - this._healthySince > 30000) {
        // 30 s of calm: try restoring the natural pick.  Anti-flap: at
        // most one upshift attempt per minute.  If the decoder re-bogs
        // within seconds the pressure-downgrade will fire again and the
        // 60 s timer prevents another retry.
        if (now - (this._lastUpshiftTime || 0) > 60000) {
          const natural = this._pickVariant(/* ignorePressure */ true);
          this._pressureDowngrade = false;
          this._lastUpshiftTime   = now;
          this._updateVariantTag();
          if (natural && natural !== this._currentQuality) this._maybeSwitchVariant();
        }
      }
    } else {
      // Middle zone: don't reset timers, but don't accumulate either.
      // Keeps the hysteresis from firing on noisy borderline values.
    }
  }

  /** Called from the resize-observer debounce.  Swaps to a different
   *  variant when the pane crosses the size threshold.  Re-uses `resync()`
   *  which closes the WS, reconnects, and re-anchors. */
  _maybeSwitchVariant() {
    if (!this._client) return;
    // effectiveMode, not this.mode: a pane mid-demote still reads 'webcodecs'
    // (that's what's on screen), and acting on it here would replace the
    // in-flight thumbnail transition with a video one — cancelling the demote.
    // setFocusedCamera calls _rerank() and then this, one line apart, so that
    // bug undid every demotion the instant it started.
    if (this.effectiveMode === 'thumbnail') return;
    const want = this._pickVariant();
    if (!want || want === this.effectiveQuality) return;
    // Bridged, not a teardown: entering fullscreen switches sub→main, and a
    // hard restart there blacked the pane out for the RTSP connect plus the
    // camera's next keyframe — the most visible moment to do that.
    this._transitionTo('webcodecs', want);
  }

  /** Render the current variant label as a single-letter tag in the
   *  hover-revealed name overlay (P = main / Primary, S = sub / Secondary).
   *  Adds a `.pressured` class + amber colour when we've been forced down
   *  to sub by the adaptive decoder-pressure check, so users can tell the
   *  difference between an intentional sub (layout / size) and a forced one.
   *  The tooltip includes the variant's probed codec (h264/hevc) so an
   *  operator hovering panes can audit the manual H.265→H.264 sub-stream
   *  migration without opening each camera's admin UI. */
  _updateVariantTag() {
    this._updateQualityControl();
    this._updateSpeakerButton();
    const el = document.getElementById(this.variantTagId);
    if (!el) return;
    if (this.mode === 'thumbnail') {
      el.textContent = 'M';
      el.title = 'Thumbnail mode — over the full-motion budget; click to focus for live video';
      el.classList.remove('pressured');
      return;
    }
    const q = this._currentQuality;
    const letter = q === 'main' ? 'P'
                 : q === 'sub'  ? 'S'
                 : (q ? q[0].toUpperCase() : '');
    el.textContent = letter;
    const codec = this.camera?.variants?.find?.((v) => v.label === q)?.videoCodec;
    const codecNote = codec ? ` — ${codec}` : '';
    if (this._pressureDowngrade) {
      el.title = `Stream variant: ${q}${codecNote} (auto-downgraded — decoder under load)`;
      el.classList.add('pressured');
    } else {
      el.title = q ? `Stream variant: ${q}${codecNote}` : '';
      el.classList.remove('pressured');
    }
  }

  _onStatus(state, detail) {
    const spinner = document.getElementById(this.loadingId);
    const status  = document.getElementById(this.statusId);
    const card    = this.element;
    if (state === 'streaming') {
      if (spinner) spinner.style.display = 'none';
      if (status)  { status.textContent = 'Live'; status.title = ''; setTimeout(() => { if (status) status.style.opacity = '0'; }, 1500); }
      // Live and rendering — let hover handle controls visibility again.
      if (card) card.classList.remove('controls-pinned');
    } else if (state === 'connecting' || state === 'reconnecting') {
      if (spinner) spinner.style.display = '';
      if (status)  { status.textContent = state === 'connecting' ? 'Connecting…' : 'Reconnecting…'; status.style.opacity = '1'; }
      // No live frame yet — keep the hover bar visible so the user can
      // still reach Remove / Restart on a stuck-loading stream.
      if (card) card.classList.add('controls-pinned');
    } else if (state === 'error') {
      // The server's reason when it sent one (STREAM_ERROR) — "The camera
      // rejected the username or password" — rather than a bare "Error".
      if (status) { status.textContent = detail ? `Error: ${detail}` : 'Error'; status.title = detail || ''; status.style.opacity = '1'; }
      if (card) card.classList.add('controls-pinned');
    }
  }

  /**
   * Switch render tier (full-motion WebCodecs ↔ MJPEG thumbnail).  Reuses
   * the status-transition rebuild path, which tears the current pipeline
   * down completely — decoder counts must not survive a demotion (verify
   * with window.__claudiferActiveDecoders).  `audioState` keeps the snapshot
   * fresh so a promotion driven by an audio-focus click starts unmuted.
   */
  setMode(mode, hoverHTML = null, audioState = null) {
    if (mode === this.effectiveMode) return;
    if (audioState) this._audioSnapshot = audioState;

    if (hoverHTML !== null) {
      const hcEl = document.getElementById(this.hoverCtrlId);
      if (hcEl) hcEl.innerHTML = hoverHTML;
    }

    if (this.camera.status !== 'running') { this.mode = mode; return; }

    // `this.mode` flips in _onIncomingReady, not here — until the new tier has
    // painted, the pane is still showing (and still is) the old one.
    // Deliberately NOT _rebuildContent(): wiping the DOM would discard the
    // very picture we're keeping on screen.
    this._transitionTo(mode, mode === 'thumbnail' ? null : this._pickVariant());
  }

  // ── Zoom ──────────────────────────────────────────────────────────

  get zoomScale() { return this._zoom.s; }

  _wrapSize() {
    const wrap = document.getElementById(this.videoWrapId);
    return wrap ? { w: wrap.clientWidth || 1, h: wrap.clientHeight || 1, wrap } : null;
  }

  /** Scale by `factor` keeping the point (px, py) — pane pixels — fixed. */
  zoomAt(px, py, factor) {
    const sz = this._wrapSize(); if (!sz) return;
    const z = this._zoom;
    const ns = Math.min(8, Math.max(1, z.s * factor));
    if (ns === z.s) return;
    const fx = px / sz.w, fy = py / sz.h;         // as fractions of the pane
    z.x = fx - (fx - z.x) * (ns / z.s);
    z.y = fy - (fy - z.y) * (ns / z.s);
    z.s = ns;
    this._applyZoom();
  }

  panBy(dxPx, dyPx) {
    const sz = this._wrapSize(); if (!sz || this._zoom.s <= 1) return;
    this._zoom.x += dxPx / sz.w;
    this._zoom.y += dyPx / sz.h;
    this._applyZoom();
  }

  resetZoom() {
    if (this._zoom.s === 1 && !this._zoom.x && !this._zoom.y) return;
    this._zoom = { s: 1, x: 0, y: 0 };
    this._applyZoom();
  }

  _applyZoom() {
    const z = this._zoom;
    // Keep the picture covering the pane: no dragging it out of view.
    z.x = Math.min(0, Math.max(1 - z.s, z.x));
    z.y = Math.min(0, Math.max(1 - z.s, z.y));
    const sz = this._wrapSize();
    const t = z.s === 1 || !sz ? '' : `translate(${z.x * sz.w}px, ${z.y * sz.h}px) scale(${z.s})`;
    for (const id of [this.canvasId, this.thumbCanvasId]) {
      const c = document.getElementById(id);
      if (c) { c.style.transformOrigin = '0 0'; c.style.transform = t; }
    }
    if (sz) sz.wrap.style.touchAction = z.s > 1 ? 'none' : 'pan-x pan-y';
    if (sz) sz.wrap.classList.toggle('zoomed', z.s > 1);
    const badge = document.getElementById(this.zoomBadgeId);
    if (badge) {
      badge.style.display = z.s > 1.001 ? '' : 'none';
      badge.textContent = `${z.s.toFixed(1)}×  ⟲`;
    }
    const card = this.element;
    if (card && this.interactive) card.draggable = z.s <= 1;   // a zoomed pane drags to pan, not to move
  }

  _bindZoom(wrap) {
    wrap.style.touchAction = 'pan-x pan-y';

    // Mouse wheel / trackpad.  ctrlKey wheel is a trackpad pinch: finer steps.
    wrap.addEventListener('wheel', (e) => {
      const r = wrap.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      if (this._zoom.s === 1 && dy > 0) return;      // nothing to zoom out of: let the page scroll
      e.preventDefault();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)));
    }, { passive: false });

    // Mouse drag to pan while zoomed.
    wrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || this._zoom.s <= 1) return;
      e.preventDefault();
      let lx = e.clientX, ly = e.clientY, moved = 0;
      const move = (m) => { moved += Math.abs(m.clientX - lx) + Math.abs(m.clientY - ly); this.panBy(m.clientX - lx, m.clientY - ly); lx = m.clientX; ly = m.clientY; };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (moved > 4) this._suppressClick = true;
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    // Badge: reset.
    wrap.addEventListener('click', (e) => {
      if (e.target.closest?.('.zoom-badge')) { e.stopPropagation(); this.resetZoom(); }
    }, true);

    // Touch: two fingers pinch (zoom about their midpoint, and pan with it);
    // one finger pans once zoomed.  Not zoomed, one finger scrolls the page.
    let g = null;
    const mid = (t) => {
      const r = wrap.getBoundingClientRect();
      if (t.length >= 2) return { x: (t[0].clientX + t[1].clientX) / 2 - r.left, y: (t[0].clientY + t[1].clientY) / 2 - r.top, d: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) };
      return { x: t[0].clientX - r.left, y: t[0].clientY - r.top, d: 0 };
    };
    const startGesture = (e) => {
      const m = mid(e.touches);
      g = { n: e.touches.length, m0: m, s0: this._zoom.s, x0: this._zoom.x, y0: this._zoom.y, moved: false };
    };
    wrap.addEventListener('touchstart', (e) => {
      if (e.touches.length >= 2) { e.preventDefault(); startGesture(e); }
      else if (this._zoom.s > 1) startGesture(e);
      else g = null;
    }, { passive: false });
    wrap.addEventListener('touchmove', (e) => {
      if (!g) return;
      if (e.touches.length !== g.n) startGesture(e);   // finger added/lifted: restart from here
      const sz = this._wrapSize(); if (!sz) return;
      const m = mid(e.touches);
      e.preventDefault();
      if (g.n >= 2 && g.m0.d > 0) {
        const ns = Math.min(8, Math.max(1, g.s0 * (m.d / g.m0.d)));
        // The content point that was under the fingers' midpoint stays under it.
        const fx0 = g.m0.x / sz.w, fy0 = g.m0.y / sz.h;
        this._zoom.s = ns;
        this._zoom.x = m.x / sz.w - (fx0 - g.x0) * (ns / g.s0);
        this._zoom.y = m.y / sz.h - (fy0 - g.y0) * (ns / g.s0);
      } else {
        this._zoom.x = g.x0 + (m.x - g.m0.x) / sz.w;
        this._zoom.y = g.y0 + (m.y - g.m0.y) / sz.h;
      }
      if (Math.abs(m.x - g.m0.x) + Math.abs(m.y - g.m0.y) > 6 || g.n >= 2) g.moved = true;
      this._applyZoom();
    }, { passive: false });
    const end = (e) => {
      if (!g) return;
      if (g.moved) { this._suppressClick = true; setTimeout(() => { this._suppressClick = false; }, 450); }
      if (e.touches.length) startGesture(e); else g = null;
    };
    wrap.addEventListener('touchend', end);
    wrap.addEventListener('touchcancel', end);
    // iOS Safari: keep a pinch on the pane from zooming the whole page.
    wrap.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  // ── Quality (High = main, Low = sub) ──────────────────────────────

  _hasBothQualities() {
    const labels = new Set((this.camera?.variants || []).map((v) => v.label));
    return labels.has('main') && labels.has('sub');
  }

  _bindSpeaker(wrap) {
    wrap.addEventListener('click', (e) => {
      if (!e.target.closest?.('.speaker-btn')) return;
      e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault();
      if (!this.grid) return;
      if (!this.grid.isPaneAudible(this.cameraId)) { this.grid.setPaneAudio(this.cameraId, true); return; }
      if (this.grid.hasPaneAudio(this.cameraId)) this.grid.setPaneAudio(this.cameraId, false);
      // Still heard: it is the focused pane, so this is the master mute.
      if (this.grid.isPaneAudible(this.cameraId)) this.grid.onFocalMuteRequest?.(this.cameraId);
    }, true);
  }

  _bindQuality(wrap, el) {
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest?.('.quality-ctl button');
      if (!b) return;
      e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault();
      if (!this.grid) return;
      if (b.dataset.q === 'auto') this.grid.setPaneQuality(this.cameraId, null);
      else this.grid.setPaneQuality(this.cameraId, this.effectiveQuality === 'main' ? 'sub' : 'main');
    }, true);
    // Touch has no hover: a tap reveals the controls for a few seconds.
    el.addEventListener('touchstart', () => {
      el.classList.add('touch-reveal');
      clearTimeout(this._revealTimer);
      this._revealTimer = setTimeout(() => el.classList.remove('touch-reveal'), 3500);
    }, { passive: true });
  }

  /** Refresh the HQ/LQ control to match what the pane is (or is becoming). */
  _updateQualityControl() {
    const ctl = document.getElementById(this.qualityCtlId);
    if (!ctl) return;
    const show = this.effectiveMode === 'webcodecs' && this._hasBothQualities() && !!this.grid;
    ctl.style.display = show ? '' : 'none';
    if (!show) return;
    const q = this.effectiveQuality;
    const manual = this.grid.paneQuality(this.cameraId);
    const btn = ctl.querySelector('.quality-btn');
    btn.textContent = q === 'main' ? 'HQ' : 'LQ';
    btn.classList.toggle('high', q === 'main');
    btn.title = (q === 'main' ? 'High quality (main stream)' : 'Low quality (substream)')
      + (this._pressureDowngrade ? ' — forced low: this device\'s decoder is overloaded' : '')
      + ' — click for ' + (q === 'main' ? 'low' : 'high');
    ctl.classList.toggle('manual', !!manual);
  }

  destroy() {
    this._teardownIntersectionObserver();
    this._teardownPressureWatch();
    this._teardownFullscreenWatch();
    if (this._bridgeTimer) { clearTimeout(this._bridgeTimer); this._bridgeTimer = null; }
    this._stopClients();
  }

  /** Combined receive rate across whichever tiers are live — during a bridge
   *  that's briefly both.  Counting the thumbnail feed here is what keeps the
   *  dashboard's bandwidth readout honest now that most panes are JPEG. */
  getReceivedBytesPerSec() {
    let total = 0;
    if (this._client)   total += this._client.getReceivedBytesPerSec?.() || 0;
    if (this._incoming) total += this._incoming.getReceivedBytesPerSec?.() || 0;
    return total;
  }

  /** True when the underlying WebCodecsClient has fallen meaningfully
   *  behind real-time — the grid uses this on tab-visible to decide which
   *  panes deserve a resync. */
  _isBehind() { return this._client?.isBehind?.() === true; }

  /**
   * Force a fresh stream — close the current client (drains queues, resets
   * decoders, closes ws) and start a new one with the same audio state.
   * Called when the grid detects the tab was hidden long enough for the
   * stream to have fallen significantly behind real-time; a full reset is
   * faster than waiting for the decoder to drain a hibernation-sized input
   * queue.
   */
  resync(audioState) {
    if (this.camera.status !== 'running') return;
    const snapshot = audioState || this._audioSnapshot;
    this._audioSnapshot = snapshot;
    this._teardownIntersectionObserver();
    if (this._bridgeTimer) { clearTimeout(this._bridgeTimer); this._bridgeTimer = null; }
    this._stopClients();
    // Defer a tick so the previous ws.close() and decoder.close() take effect
    // before we spin up replacements that will race for the same canvas.
    setTimeout(() => {
      if (this.camera.status === 'running' && !this._client && !this._incoming) {
        this.startStream(snapshot);
      }
    }, 50);
  }

  /**
   * Incremental status update.  Handles three cases:
   *   1. Status unchanged — patch status dot + hover controls, done.
   *   2. Running → Stopped/Error — tear down the client and swap the
   *      video-wrap contents to a placeholder.
   *   3. Stopped/Error → Running — swap video-wrap contents to a fresh
   *      canvas and start the stream.
   */
  updateStatus(cam, hoverHTML = '') {
    const wasRunning = this.camera.status === 'running';
    const isRunning  = cam.status === 'running';
    this.camera = cam;

    if (wasRunning !== isRunning) {
      this._rebuildContent(hoverHTML, /* shouldStart */ isRunning);
      return;
    }

    const dot = this.element?.querySelector('.status-dot');
    if (dot) {
      dot.className = `status-dot ${cam.status === 'running' && cam.lastError ? 'error' : cam.status}`;
      dot.title = cam.lastError || '';
    }
    if (hoverHTML !== null) {
      const hcEl = document.getElementById(this.hoverCtrlId);
      if (hcEl) hcEl.innerHTML = hoverHTML;
    }
  }

  /** Rebuild the video-wrap inner HTML to match the current camera status.
   *  Stops any running client first so it doesn't try to draw into a
   *  detached canvas. */
  _rebuildContent(hoverHTML, shouldStart) {
    this._teardownIntersectionObserver();
    if (this._bridgeTimer) { clearTimeout(this._bridgeTimer); this._bridgeTimer = null; }
    this._stopClients();
    const wrap = document.getElementById(this.videoWrapId);
    if (!wrap) return;

    wrap.innerHTML = this._innerHTML();
    this._zoom = { s: 1, x: 0, y: 0 };

    if (hoverHTML !== null) {
      const hcEl = document.getElementById(this.hoverCtrlId);
      if (hcEl) hcEl.innerHTML = hoverHTML;
    }

    if (shouldStart) {
      // Defer one tick so the new <canvas> is painted before the decoder
      // latches onto it.
      setTimeout(() => this.startStream(this._audioSnapshot), 0);
    }
  }

  setFocalStream(isFocal, volume, muted) {
    this.isFocalStream = isFocal;
    this.element?.classList.toggle('focal-stream', isFocal);
    // Optional calls: a thumbnail-tier client has no audio graph at all.  A
    // focused pane is always promoted to full motion by the grid's re-rank,
    // so this is only ever a no-op on the way past.
    // Audible when it is the focused pane and the master is unmuted, or when
    // its own speaker button is on.
    const extra = !!this.grid?.hasPaneAudio(this.cameraId);
    const audible = (isFocal && !(muted ?? false)) || extra;
    this._updateSpeakerButton(audible);
    if (!this._client) return;
    this._client.setVolume?.(volume ?? this.grid?._audio?.volume ?? 1);
    this._client.setMuted?.(!audible);
  }

  /** Show/refresh this pane's speaker button.  `audible` = currently heard. */
  _updateSpeakerButton(audible) {
    const b = document.getElementById(this.speakerBtnId);
    if (!b) return;
    const vs = this.camera?.variants || [];
    // Hide it only when the camera is known to have no audio track.
    const knownSilent = vs.length > 0 && vs.every((v) => v.videoCodec && !v.audioCodec);
    const show = this.camera?.status === 'running' && !!this.grid && !knownSilent;
    b.style.display = show ? '' : 'none';
    if (!show) return;
    if (audible === undefined) audible = this.grid.isPaneAudible(this.cameraId);
    const extra = this.grid.hasPaneAudio(this.cameraId);
    b.classList.toggle('on', audible);
    b.classList.toggle('extra', extra);
    b.innerHTML = audible ? CameraPane.ICON_SOUND : CameraPane.ICON_MUTED;
    b.title = audible
      ? (extra ? 'Playing this camera too — click to turn it off' : 'This is the camera being listened to — click to mute')
      : 'Listen to this camera too';
  }

  static get ICON_SOUND() {
    return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<polygon points="4 7 8 7 13 3 13 17 8 13 4 13" fill="currentColor" stroke="none"/>'
      + '<path d="M15.5 7.5a3.5 3.5 0 0 1 0 5"/><path d="M17.5 5.5a6 6 0 0 1 0 9"/></svg>';
  }
  static get ICON_MUTED() {
    return '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<polygon points="4 7 8 7 13 3 13 17 8 13 4 13" fill="currentColor" stroke="none"/>'
      + '<line x1="15" y1="8" x2="19" y2="12"/><line x1="19" y1="8" x2="15" y2="12"/></svg>';
  }
}


// ─── CameraGrid ────────────────────────────────────────────────────────
/**
 * Manages a grid of CameraPanes — creates and tears down panes as the layout
 * changes, performs incremental status-only updates on poll, and routes
 * callbacks (hover HTML, empty slots, drag/drop, audio focus) to the host.
 */
export class CameraGrid {
  constructor({ container, wsUrl, idPrefix = '', bufferMs, layoutDefs, maxFullMotionPanes, interactive = true, fullMotion,
                qualityPolicy, mainMinWidth } = {}) {
    this.container  = container;
    // false → every pane is a JPEG thumbnail (no WebCodecs in this browser).
    this.fullMotion = fullMotion ?? webCodecsAvailable();
    this.wsUrl      = wsUrl;
    // false → panes are drag-inert and no interaction callbacks are attached.
    this.interactive = interactive;
    this.idPrefix   = idPrefix;
    this.bufferMs   = bufferMs;
    this.layoutDefs = layoutDefs || CameraGrid.defaultLayoutDefs();
    // Full-motion decode budget (see computeFullMotionSet).  Server default
    // arrives via /api/info like bufferMs does.
    this.maxFullMotionPanes = maxFullMotionPanes ?? 10;

    // Stream quality — see the header.  The server's policy (from /api/info),
    // a view-wide override, and per-pane choices remembered by this browser.
    this.qualityPolicy   = qualityPolicy || 'sub';
    this.mainMinWidth    = mainMinWidth || 1280;
    this.qualityOverride = null;
    this._paneQuality    = new Map();
    try {
      const saved = JSON.parse(localStorage.getItem(CameraGrid.PANE_QUALITY_KEY) || '{}');
      for (const [k, v] of Object.entries(saved)) if (v === 'main' || v === 'sub') this._paneQuality.set(k, v);
    } catch { /* storage off */ }

    this._panes     = new Map();
    this._prevSlots = {};
    this._layout    = null;
    this._cameras   = [];
    this._audio     = { focal: null, volume: 1, muted: true };
    // Panes whose own speaker button is on — heard in addition to the focal one.
    this._extraAudio = new Set();
    // Host hook: the speaker on the focused pane was clicked off.  The host
    // should mute its master control (the dashboard's top button, the wall's).
    this.onFocalMuteRequest = null;

    // featuredSlot → stored slot currently displayed in it.  Display state
    // only — see computeMultiDisplayOrder; `_layout.slots` is never touched.
    // At most one swap per zone, and zones are disjoint, so "where is stored
    // slot i on screen?" stays trivial: position i, unless i is one of the
    // two swapped within its own zone.
    this._tempFocus = new Map();

    // Eagerly create the shared AudioContext (and install its one-shot
    // user-gesture unlock listener) at grid construction.  If we waited
    // until a client's AUDIO_CONFIG arrived, a user click landing before
    // that moment would have nothing to unlock — its gesture token would
    // expire unused and audio would stay silent until a later click.
    ensureSharedAudioContext();

    this.buildHoverControls = null;
    this.buildEmptySlot     = null;
    this.onPaneFocusRequest = null;
    this.onPaneDblClick     = null;
    this.onSlotDragStart    = null;
    this.onSlotDragEnd      = null;
    this.onSlotDragOver     = null;
    this.onSlotDrop         = null;
    this.onSlotDragLeave    = null;

    // When a tab is hidden, browsers throttle rAF and may slow down the
    // WebCodecs pipeline; on unhide the decoder / video queue can be far
    // enough behind that the user sees stale content until the backlog
    // drains.  On every visibility→visible transition, ask each pane's
    // client whether it's behind, and resync only the ones that are — no
    // churn for panes that survived the hide gracefully.
    this._visibilityHandler = () => {
      if (document.visibilityState !== 'visible') return;
      const audio = this._audio;
      for (const pane of this._panes.values()) {
        if (pane._isBehind()) pane.resync(audio);
      }
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);

    // Budget re-rank triggers.  Fullscreen enter/exit changes which pane is
    // pinned; container resize (window resize, sidebar drag) changes pane
    // areas.  Resize is debounced so a drag doesn't re-rank per pixel —
    // pane variant re-picks piggyback on the same tick, since a size change
    // affects both decisions.
    this._fullscreenRerank = () => this._rerank();
    document.addEventListener('fullscreenchange', this._fullscreenRerank);
    this._resizeDebounce = null;
    this._resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined' && container) {
      this._resizeObserver = new ResizeObserver(() => {
        clearTimeout(this._resizeDebounce);
        this._resizeDebounce = setTimeout(() => {
          this._resizeDebounce = null;
          this._rerank();
          for (const pane of this._panes.values()) pane._maybeSwitchVariant?.();
        }, 300);
      });
      this._resizeObserver.observe(container);
    }
  }

  // ── Public API ──────────────────────────────────────────────────

  setLayout(layout, cameras) {
    // A different layout (or a different grid shape) invalidates the temp
    // focus swap — its slot indices refer to the outgoing layout.  Note this
    // runs on every 5 s poll with the same layout, so compare identity rather
    // than clearing unconditionally.
    if (layout?.id !== this._layout?.id || layout?.gridType !== this._layout?.gridType) {
      this._tempFocus.clear();
    }
    this._layout  = layout;
    this._cameras = cameras;
    this._applyContainerCSS();
    this._render();
  }

  update(cameras) {
    this._cameras = cameras;
    if (!this._layout) return;
    const def = this._def();
    const slotCount = def.slots || (def.cols * def.rows);
    for (let i = 0; i < slotCount; i++) {
      const slot = this._layout.slots[String(i)];
      if (!slot) continue;
      const cam = cameras.find(c => c.id === slot.cameraId);
      const pane = this._panes.get(slot.cameraId);
      if (cam && pane) {
        const hc = this.buildHoverControls?.(cam, i) ?? '';
        pane.updateStatus(cam, hc);
      }
    }
    // Cameras coming online (or going away) shift the budget picture; the
    // 5 s poll cadence bounds how long the grid can drift over budget.
    // Hysteresis in the ranking keeps this a no-op when nothing changed.
    this._rerank();
  }

  /**
   * Change the decode budget and re-rank immediately.  Client-side so it takes
   * effect without a server restart, and so one machine's limit doesn't apply
   * to every viewer — GPU decode headroom varies enormously across the PCs
   * pointed at the same server.
   */
  setMaxFullMotionPanes(n) {
    const next = Math.max(1, Math.floor(n) || 1);
    if (next === this.maxFullMotionPanes) return;
    this.maxFullMotionPanes = next;
    this._rerank();
  }

  setFocusedCamera(cameraId, volume, muted) {
    const prev = this._audio.focal;
    this._audio = { focal: cameraId, volume, muted };
    if (prev && prev !== cameraId) this._panes.get(prev)?.setFocalStream(false);
    if (cameraId) this._panes.get(cameraId)?.setFocalStream(true, volume, muted);
    for (const id of this._extraAudio) if (id !== cameraId) this._syncPaneAudio(id);   // volume follows the master
    // On a featured layout the large panel IS the focus panel, so the focused
    // camera moves into it.  Display-only: `_layout.slots` is untouched and
    // nothing is persisted.  No-op on plain grids (no featured slot).
    this._applyTempFocus(this._storedSlotOf(cameraId));
    // The focal pane is pinned full-motion — clicking a thumbnail pane is
    // exactly this path, so re-rank promotes it (and demotes the smallest
    // full-motion pane when at budget).
    this._rerank();
    // The featured slot earns the `main` variant (see _layoutPreferredVariant),
    // so a swap changes which pane wants which quality.  Cheap: resync only
    // fires where the pick actually differs from what's subscribed.
    for (const pane of this._panes.values()) pane._maybeSwitchVariant?.();
  }

  // ── Per-pane audio ───────────────────────────────────────────────

  hasPaneAudio(cameraId) { return this._extraAudio.has(cameraId); }

  isPaneAudible(cameraId) {
    return (this._audio.focal === cameraId && !this._audio.muted) || this._extraAudio.has(cameraId);
  }

  /** Turn one pane's own speaker on or off. */
  setPaneAudio(cameraId, on) {
    if (on) this._extraAudio.add(cameraId); else this._extraAudio.delete(cameraId);
    this._syncPaneAudio(cameraId);
    // An audible pane must be full motion (a thumbnail has no sound): re-rank pins it.
    this._rerank();
  }

  /** Every pane speaker off (the master mute does this). */
  clearPaneAudio() {
    const ids = [...this._extraAudio];
    this._extraAudio.clear();
    for (const id of ids) this._syncPaneAudio(id);
    this._rerank();
  }

  _syncPaneAudio(cameraId) {
    const pane = this._panes.get(cameraId);
    if (!pane) return;
    const a = this._audio;
    pane.setFocalStream(a.focal === cameraId, a.volume, a.muted);
  }

  _syncAllAudio() { for (const id of this._panes.keys()) this._syncPaneAudio(id); }

  // ── Quality ──────────────────────────────────────────────────────

  static get PANE_QUALITY_KEY() { return 'claudifer_pane_quality'; }

  /** Server policy: 'sub' | 'fullscreen' | 'large' | 'main'. */
  setQualityPolicy(policy, mainMinWidth) {
    if (policy) this.qualityPolicy = policy;
    if (mainMinWidth) this.mainMinWidth = mainMinWidth;
    this._requality();
  }

  /** Whole-view override: 'main' (High), 'sub' (Low) or null (automatic). */
  setQualityOverride(q) {
    this.qualityOverride = q === 'main' || q === 'sub' ? q : null;
    this._requality();
  }

  /** One pane's override, remembered in this browser; null returns it to automatic. */
  setPaneQuality(cameraId, q) {
    if (q === 'main' || q === 'sub') this._paneQuality.set(cameraId, q);
    else this._paneQuality.delete(cameraId);
    try { localStorage.setItem(CameraGrid.PANE_QUALITY_KEY, JSON.stringify(Object.fromEntries(this._paneQuality))); }
    catch { /* storage off */ }
    const pane = this._panes.get(cameraId);
    pane?._maybeSwitchVariant?.();
    pane?._updateQualityControl?.();
  }

  paneQuality(cameraId) { return this._paneQuality.get(cameraId) || null; }

  _requality() {
    for (const pane of this._panes.values()) {
      pane._maybeSwitchVariant?.();
      pane._updateQualityControl?.();
    }
  }

  /** Reset zoom on one pane, or on every pane. */
  resetZoom(cameraId) {
    if (cameraId) { this._panes.get(cameraId)?.resetZoom(); return; }
    for (const pane of this._panes.values()) pane.resetZoom();
  }

  /** The pane rendered by a grid child element, if any. */
  _paneOfElement(el) {
    if (!el) return null;
    for (const pane of this._panes.values()) if (pane.element === el) return pane;
    return null;
  }

  /** True when the current layout has at least one large/featured panel. */
  hasFeaturedSlot() { return this._featureZones() !== null; }

  /** True when `cameraId` is the camera currently occupying ANY featured
   *  panel — the host uses this to decide that a click means "fullscreen"
   *  rather than "swap me up there". */
  isInFeaturedSlot(cameraId) {
    const zones = this._featureZones();
    if (!zones || !cameraId || !this._layout?.slots) return false;
    for (const f of zones.features) {
      const storedIdx = this._tempFocus.has(f) ? this._tempFocus.get(f) : f;
      if (this._layout.slots[String(storedIdx)]?.cameraId === cameraId) return true;
    }
    return false;
  }

  /** Featured zones for the active layout, or null for a plain grid. */
  _featureZones() {
    return featureZonesOf(this._def(), this._slotCount());
  }

  /** Primary featured slot index for the active layout, or null. */
  _featuredSlot() {
    const zones = this._featureZones();
    return zones ? zones.features[0] : null;
  }

  /** Back-compat view of the old single-swap state: the stored slot promoted
   *  into the primary feature, or null.  Single-featured layouts have exactly
   *  one zone, so this is identical to what it always was. */
  get _tempFocusSlot() {
    const f = this._featuredSlot();
    if (f === null) return null;
    return this._tempFocus.has(f) ? this._tempFocus.get(f) : null;
  }

  _slotCount() {
    const def = this._def();
    return def.slots || ((def.cols || 0) * (def.rows || 0));
  }

  /** Stored slot index holding `cameraId`, or null. */
  _storedSlotOf(cameraId) {
    if (!cameraId || !this._layout?.slots) return null;
    for (const [key, slot] of Object.entries(this._layout.slots)) {
      if (slot?.cameraId === cameraId) return Number(key);
    }
    return null;
  }

  /**
   * Move the camera from stored slot `storedSlotIdx` into the featured panel,
   * or pass null to restore the layout's natural order.  Reorders DOM
   * children in place, so the occupying panes keep their WebCodecsClient,
   * decoder, canvas, and audio graph — no reconnect, no black flash.
   *
   * Always restores before applying so at most one swap pair is live; that
   * invariant is what lets `_displayOrder` be a single exchange and keeps the
   * DOM-position arithmetic here trivial.
   */
  _applyTempFocus(storedSlotIdx) {
    const zones = this._featureZones();
    if (!zones) { this._clearTempFocus(); return; }

    const slotCount = this._slotCount();
    const target = Number.isInteger(storedSlotIdx) &&
      storedSlotIdx >= 0 && storedSlotIdx < slotCount ? storedSlotIdx : null;

    // Nothing focusable (focus cleared, or the camera left the layout):
    // every zone goes back to its natural order.
    if (target === null) { this._clearTempFocus(); return; }

    // Route to the large panel that owns this slot, NOT to the layout's
    // primary one.  On a two-up layout that means a click below the right
    // feature promotes into the right feature and leaves the left alone —
    // each side keeps to itself.
    const f = zones.featureOf[target];
    if (!Number.isInteger(f)) return;

    // Clicking the camera already in this zone's panel restores that zone.
    const desired = target === f ? null : target;
    const current = this._tempFocus.has(f) ? this._tempFocus.get(f) : null;
    if (desired === current) return;

    this._restoreZone(f);
    if (desired !== null) {
      this._swapDomChildren(f, desired);
      this._tempFocus.set(f, desired);
    }
  }

  /** Undo one zone's swap, leaving every other zone as it is. */
  _restoreZone(featuredSlot) {
    if (!this._tempFocus.has(featuredSlot)) return;
    // A positional exchange is its own inverse, and a zone's two displaced
    // positions are always exactly {feature, temp} — so re-swapping the same
    // pair restores it without disturbing the neighbouring zone.
    this._swapDomChildren(featuredSlot, this._tempFocus.get(featuredSlot));
    this._tempFocus.delete(featuredSlot);
  }

  /** Undo every zone's swap. */
  _clearTempFocus() {
    for (const f of [...this._tempFocus.keys()]) this._restoreZone(f);
  }

  /** Exchange two container children by position, preserving both elements
   *  (and therefore every listener and live stream attached to them). */
  _swapDomChildren(posA, posB) {
    const a = this.container?.children[posA];
    const b = this.container?.children[posB];
    if (!a || !b || a === b) return;
    // Both panes change position: their zoom goes back to normal.
    this._paneOfElement(a)?.resetZoom();
    this._paneOfElement(b)?.resetZoom();
    const placeholder = document.createComment('claudifer-tempfocus');
    a.replaceWith(placeholder);
    b.replaceWith(a);
    placeholder.replaceWith(b);
  }

  /** `order[displayPosition] = storedSlotIndex` for the active layout. */
  _displayOrder() {
    return computeMultiDisplayOrder(this._slotCount(), [...this._tempFocus.entries()]);
  }

  /**
   * Recompute the full-motion set and flip pane modes to match.  Cheap
   * enough to call on every trigger (a few getBoundingClientRect calls);
   * setMode() is a no-op for panes already in the right tier.
   */
  _rerank() {
    if (!this._layout || this._panes.size === 0) return;
    if (!this.fullMotion) {
      for (const pane of this._panes.values()) {
        if (pane.camera.status === 'running' && pane.effectiveMode !== 'thumbnail') pane.setMode('thumbnail', null, this._audio);
      }
      return;
    }
    const entries = [];
    for (const pane of this._panes.values()) {
      if (pane.camera.status !== 'running') continue;  // placeholders cost nothing
      const el   = pane.element;
      const rect = el?.getBoundingClientRect?.();
      entries.push({
        id:     pane.cameraId,
        area:   rect ? rect.width * rect.height : 0,
        slot:   pane.slotIndex,
        pinned: (!!document.fullscreenElement && document.fullscreenElement === el) ||
                this._audio.focal === pane.cameraId || this._extraAudio.has(pane.cameraId),
      });
    }
    // effectiveMode throughout: a pane mid-transition reports the tier that's
    // on screen, not the one it's heading for, so ranking on `mode` would
    // treat a demoting pane as a full-motion incumbent and re-decide against
    // a state that's already changing.
    const prevIds = [...this._panes.values()]
      .filter((p) => p.effectiveMode === 'webcodecs')
      .map((p) => p.cameraId);
    const full = computeFullMotionSet(entries, this.maxFullMotionPanes, prevIds);

    for (const pane of this._panes.values()) {
      if (pane.camera.status !== 'running') continue;
      const want = full.has(pane.cameraId) ? 'webcodecs' : 'thumbnail';
      if (want === pane.effectiveMode) continue;
      const cam = this._cameras.find((c) => c.id === pane.cameraId);
      const hc  = cam ? (this.buildHoverControls?.(cam, pane.slotIndex) ?? '') : '';
      pane.setMode(want, hc, this._audio);
    }
  }

  resyncAll() {
    if (!this._layout) return;
    for (const slot of Object.values(this._layout.slots)) {
      this._panes.get(slot?.cameraId)?.resync(this._audio);
    }
  }

  getPane(cameraId) { return this._panes.get(cameraId); }

  /**
   * Sum of received bytes/sec across every pane's WebCodecs client over
   * the elapsed window since the previous call.  Hosts (the dashboard
   * header) can poll this on a fixed cadence to display total client-side
   * bandwidth pressure.  Returns 0 when no panes are streaming.
   */
  getTotalReceivedBytesPerSec() {
    let total = 0;
    for (const pane of this._panes.values()) {
      total += pane.getReceivedBytesPerSec?.() || 0;
    }
    return total;
  }

  /**
   * Swap (or move) two slot positions without tearing down their streams.
   * The DOM children at `srcIdx` and `tgtIdx` are exchanged in place; any
   * occupying CameraPane keeps its WebCodecsClient, decoders, AudioWorklet,
   * and canvas — no reconnect, no black-flash, no audio glitch.
   *
   * Either slot may be empty; this also handles "move into an empty slot"
   * since the empty placeholder element is just swapped in the other
   * direction.  The host page is responsible for persisting the new layout
   * to the server (silently, no rerender) after calling this.
   */
  swapSlots(srcIdx, tgtIdx) {
    if (srcIdx === tgtIdx) return;
    if (!this._layout) return;

    // Drag-drop is the only thing that mutates the stored layout.  Undo any
    // display-only focus swap first so `container.children[i]` corresponds to
    // stored slot i again — the DOM juggling below assumes that, and so does
    // _refreshSlotIndex's empty-placeholder path.
    this._applyTempFocus(null);

    const srcKey = String(srcIdx);
    const tgtKey = String(tgtIdx);
    const srcSlot = this._layout.slots[srcKey] || null;
    const tgtSlot = this._layout.slots[tgtKey] || null;

    // ── Update layout slot-map ────────────────────────────────────────
    if (srcSlot) this._layout.slots[tgtKey] = srcSlot;
    else         delete this._layout.slots[tgtKey];
    if (tgtSlot) this._layout.slots[srcKey] = tgtSlot;
    else         delete this._layout.slots[srcKey];

    // ── Keep the slot fingerprint in sync ────────────────────────────
    // The next setLayout() call uses _prevSlots to short-circuit when no
    // slot changed.  After our manual swap _layout.slots is at its new
    // state, so _prevSlots needs to match — otherwise the next status
    // poll would think slots changed and trigger a full rerender (which
    // would defeat the whole point of the swap).
    const sFP = this._prevSlots[srcIdx];
    const tFP = this._prevSlots[tgtIdx];
    this._prevSlots[srcIdx] = tFP;
    this._prevSlots[tgtIdx] = sFP;

    // ── Swap DOM children in place ────────────────────────────────────
    const srcEl = this.container.children[srcIdx];
    const tgtEl = this.container.children[tgtIdx];
    this._paneOfElement(srcEl)?.resetZoom();
    this._paneOfElement(tgtEl)?.resetZoom();
    if (srcEl && tgtEl && srcEl !== tgtEl) {
      const placeholder = document.createComment('claudifer-swap');
      srcEl.replaceWith(placeholder);
      tgtEl.replaceWith(srcEl);
      placeholder.replaceWith(tgtEl);
    }

    // ── Refresh per-slot metadata (slotIndex, slot number, hover) ────
    this._refreshSlotIndex(srcIdx);
    this._refreshSlotIndex(tgtIdx);
  }

  /**
   * After a swap, rewrite anything in the slot's DOM that references the
   * slot's index — the visible "1, 2, 3…" badge and (for empty placeholders)
   * the inline ondrop/ondragover handlers that bake the index as a literal.
   * For occupied panes we just patch the pane's `slotIndex` field; the
   * event listeners attached in `pane.bind()` reference it through `this`,
   * so they pick up the new value automatically.
   */
  _refreshSlotIndex(slotIdx) {
    const slot = this._layout?.slots?.[String(slotIdx)];
    if (slot) {
      const cam = this._cameras.find((c) => c.id === slot.cameraId);
      const pane = this._panes.get(slot.cameraId);
      if (!pane) return;
      pane.slotIndex = slotIdx;
      const numEl = pane.element?.querySelector('.slot-num');
      if (numEl) numEl.textContent = String(slotIdx + 1);
      const hcEl = document.getElementById(pane.hoverCtrlId);
      if (hcEl && cam && this.buildHoverControls) {
        hcEl.innerHTML = this.buildHoverControls(cam, slotIdx);
      }
      // Slot index changed → the layout's preferred variant for this pane
      // may have changed (e.g. swapped into / out of slot 0 of a featured
      // layout).  Trigger a re-pick; resync only fires if the variant
      // actually differs from what's currently subscribed.
      pane._maybeSwitchVariant?.();
      return;
    }
    // Empty slot — the placeholder's inline drag/drop handlers bake the
    // index as a string literal, so we have to re-render it whole.
    const el = this.container.children[slotIdx];
    if (!el || !this.buildEmptySlot) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = this.buildEmptySlot(slotIdx);
    const fresh = tmp.firstElementChild;
    if (fresh) el.replaceWith(fresh);
  }

  /**
   * Release everything the constructor attached, plus every pane.  For hosts
   * that throw the grid away (the camera wall rebuilds on a story change).
   */
  destroy() {
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._fullscreenRerank) {
      document.removeEventListener('fullscreenchange', this._fullscreenRerank);
      this._fullscreenRerank = null;
    }
    if (this._resizeObserver) {
      try { this._resizeObserver.disconnect(); } catch { /* ignore */ }
      this._resizeObserver = null;
    }
    if (this._resizeDebounce) { clearTimeout(this._resizeDebounce); this._resizeDebounce = null; }
    this.destroyAll();
  }

  /**
   * Stop every stream and empty the grid, keeping the grid itself usable —
   * the dashboard calls this on a layout switch and then setLayout()s again.
   * (Upstream also removed the grid's own listeners here, which left a
   * re-used grid deaf to resize and fullscreen after the first switch.)
   */
  destroyAll() {
    this._panes.forEach(p => p.destroy());
    this._panes.clear();
    this._prevSlots = {};
    // Straight clear, not _clearTempFocus(): the DOM is about to be emptied,
    // so there is nothing to swap back and the positions no longer exist.
    this._tempFocus.clear();
    this.container.innerHTML = '';
  }

  // ── Private ─────────────────────────────────────────────────────

  _def() {
    return this.layoutDefs[this._layout?.gridType] ?? CameraGrid.defaultLayoutDefs()['2x2'];
  }

  _applyContainerCSS() {
    const def = this._def();
    this.container.style.setProperty('--grid-cols', def.cols);
    this.container.style.setProperty('--grid-rows', def.rows);
    this.container.className = `grid layout-${this._layout?.gridType || '2x2'}`;
  }

  _render() {
    const { _layout: layout, _cameras: cameras } = this;
    const def = this._def();
    const slotCount = def.slots || (def.cols * def.rows);

    // Fingerprint & short-circuit when nothing changed.
    const newSlots = {};
    for (let i = 0; i < slotCount; i++) {
      const slot = layout.slots[String(i)];
      newSlots[i] = slot ? slot.cameraId : null;
    }
    const prevCount = Object.keys(this._prevSlots).length;
    const changed = slotCount !== prevCount ||
      Object.keys(newSlots).some(k => newSlots[k] !== this._prevSlots[k]);
    if (!changed) { this.update(cameras); return; }

    // Destroy every existing pane before replacing the container DOM.  A
    // layout change calls `container.innerHTML = html` below, which evicts
    // all existing canvases from the document; any surviving CameraPane
    // would keep its WebCodecsClient running (ws, VideoDecoder, AudioDecoder,
    // GainNode) with no visible output — a fast-growing leak across repeated
    // layout switches.  Only preserving panes whose camera was removed from
    // `liveIds` (as a prior optimisation attempted) isn't enough, because a
    // camera kept across layouts still gets remounted as a fresh CameraPane
    // and its stale predecessor ends up orphaned in `_panes`.
    for (const pane of this._panes.values()) pane.destroy();
    this._panes.clear();

    // Build the new HTML and track which panes to mount.  Children are
    // emitted in DISPLAY order so an active focus swap survives a rebuild,
    // but every pane keeps its STORED slot index — the slot-number badge,
    // number-key focus, and drag-drop targets all refer to the saved layout,
    // which a display-only swap must not disturb.
    let html = '';
    const toMount = [];
    for (const storedIdx of this._displayOrder()) {
      const slot = layout.slots[String(storedIdx)];
      if (slot) {
        const cam = cameras.find(c => c.id === slot.cameraId);
        if (cam) {
          const pane = new CameraPane({
            cameraId:      cam.id,
            camera:        cam,
            slotIndex:     storedIdx,
            wsUrl:         this.wsUrl,
            idPrefix:      this.idPrefix,
            isFocalStream: this._audio.focal === cam.id,
            bufferMs:      this.bufferMs,
            interactive:   this.interactive,
            mode:          this.fullMotion ? 'webcodecs' : 'thumbnail',
          });
          toMount.push({ pane, i: storedIdx, cam });
          html += pane.buildHTML();
          continue;
        }
      }
      html += this._emptySlotHTML(storedIdx);
    }

    this.container.innerHTML = html;
    this._prevSlots = newSlots;

    for (const { pane, i, cam } of toMount) {
      pane.bind(this.buildHoverControls?.(cam, i) ?? '');

      // A read-only grid attaches none of these, so a pane can't be focused,
      // dragged or dropped even if a caller left a callback set.
      if (this.interactive) {
        pane.onFocusRequest = (cid)   => this.onPaneFocusRequest?.(cid);
        pane.onDblClick     = (si, e) => this.onPaneDblClick?.(si, e);
        pane.onDragStart    = (si, e) => this.onSlotDragStart?.(si, e);
        pane.onDragEnd      = (e)     => this.onSlotDragEnd?.(e);
        pane.onDragOver     = (si, e) => this.onSlotDragOver?.(si, e);
        pane.onDrop         = (si, e) => this.onSlotDrop?.(si, e);
        pane.onDragLeave    = (e)     => this.onSlotDragLeave?.(e);
      }
      pane.getLayoutPreferredVariant = (slotIdx) => this._layoutPreferredVariant(slotIdx);
      pane.grid = this;

      this._panes.set(cam.id, pane);
      if (cam.status === 'running') {
        setTimeout(() => pane.startStream(this._audio), 0);
      }
    }

    // A pane speaker for a camera no longer on this grid goes away.
    for (const id of [...this._extraAudio]) if (!this._panes.has(id)) this._extraAudio.delete(id);

    // Apply the decode budget before any deferred startStream fires: panes
    // are built in webcodecs mode, and this synchronously demotes the
    // over-budget ones to thumbnails (getBoundingClientRect forces layout,
    // so real rendered areas are available even pre-paint).  The demoted
    // panes' pending startStream calls then no-op into thumbnail mode —
    // no decoder is ever created past the budget.
    this._rerank();
  }

  /**
   * Tells a pane whether the current layout makes it effectively
   * fullscreen.  Returns `'main'` only for layouts that have a single
   * slot (`1x1`) — the lone pane fills the whole grid, so it should get
   * the primary stream.  Every other layout returns `null`, leaving the
   * pane to fall back to actual browser-fullscreen detection (which
   * resolves to `sub` for grid views).
   */
  _layoutPreferredVariant(slotIdx) {
    const def = this._def();
    if (!def) return null;
    const totalSlots = def.slots || ((def.cols || 0) * (def.rows || 0));
    // `main` is reserved for a pane that genuinely fills the screen: browser
    // fullscreen (handled in _pickVariant) or a 1x1 layout, which is the same
    // thing by another route.  Everything on a multi-pane board takes `sub`.
    //
    // Featured panels used to earn `main` on the grounds that a sub-stream
    // stretched across them looks soft.  Measured here, that trade was wrong:
    // `main` is 2880x1620 (4.67 MP) against `sub` at 1280x720 (0.92 MP), and
    // a featured panel is typically ~850x490 on screen — so `sub` already
    // exceeds its display size and downscales cleanly, while `main` cost 5x
    // the decode for no visible gain.  It mattered because HEVC hardware
    // decode is the component that fails on these clients: Chrome ships no
    // software HEVC fallback, concurrent HEVC decoders were observed emitting
    // green frames, and two Chromium builds on one machine disagreed about
    // the geometry of the same 2880x1620 bitstream.  Capping board panes at
    // `sub` means at most ONE 4.67 MP decode exists at a time, and only when
    // an operator deliberately goes fullscreen.
    //
    // It also makes the two render tiers agree: MJPEG thumbnails are encoded
    // from `sub`, so every pane on a board now derives from the same feed and
    // switching tiers cannot change framing.
    if (totalSlots === 1) return 'main';
    return null;
  }

  _emptySlotHTML(slotIndex) {
    if (this.buildEmptySlot) return this.buildEmptySlot(slotIndex);
    return `
      <div class="camera-card placeholder-card">
        <div class="slot-number-badge">${slotIndex + 1}</div>
        <div class="drop-hint">Drop a camera here</div>
      </div>`;
  }

  static defaultLayoutDefs() {
    return {
      // `featured` = index of the layout's large panel, matching the CSS
      // (:first-child / :nth-child(5)).  Layouts without one get no temp
      // focus swap — a click there only moves audio focus.
      '1x1': { cols: 1, rows: 1 },
      '2x2': { cols: 2, rows: 2 },
      '3x2': { cols: 3, rows: 2 },
      '6f':  { cols: 3, rows: 3, slots: 6,  featured: 0 },
      // One full-width feature over two rows of three.  4 rows so the feature
      // takes exactly the top half (rows 1-2) and the six small panes fill
      // rows 3-4, three per row.
      '7f':  { cols: 3, rows: 4, slots: 7,  featured: 0 },
      // 8f / 10f have CSS in the shared stylesheet and are selectable from the
      // dashboard, so they belong in the defaults too — a layout saved as
      // either would otherwise fall back to 2x2 for any caller relying on
      // these defaults (the view-only page does).
      '8f':  { cols: 4, rows: 4, slots: 8,  featured: 0 },
      '10f': { cols: 5, rows: 5, slots: 10, featured: 0 },
      '3x3': { cols: 3, rows: 3 },
      '4x4': { cols: 4, rows: 4 },
      '13f': { cols: 4, rows: 4, slots: 13, featured: 4 },
      '5x5': { cols: 5, rows: 5 },
      '17f': { cols: 5, rows: 5, slots: 17, featured: 5 },
      // Two 2×2 features side by side across the top of a 4×4, eight small
      // below.  `featureOf` gives each small slot column affinity, so a click
      // promotes into the large pane directly above it and the other side is
      // left alone.  Slots 2-5 are row 3 (cols 1-4), 6-9 are row 4, so the
      // left half is 2,3,6,7 and the right half is 4,5,8,9.
      // `featured` stays for callers that just want the primary panel.
      '10d': {
        cols: 4, rows: 4, slots: 10,
        featured: 0,
        features: [0, 1],
        featureOf: [0, 1, 0, 0, 1, 1, 0, 0, 1, 1],
      },
      // 7f doubled: two features side by side over two rows of six.  Column
      // affinity mirrors 10d — the left three of each small row promote into
      // the left feature, the right three into the right one.
      '14d': {
        cols: 6, rows: 4, slots: 14,
        featured: 0,
        features: [0, 1],
        featureOf: [0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1],
      },
    };
  }
}
