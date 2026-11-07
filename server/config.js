'use strict';
/**
 * Configuration and persistence.
 *
 * Everything LookyLooky remembers lives in DATA_DIR (a Docker volume, /data):
 *   settings.json   camera-engine settings (ffmpeg, webcodecs, mjpeg, recordings)
 *   cameras.json    camera definitions, including their stream URLs
 *   layouts.json    named grid layouts
 *   certs/          the generated local CA and server certificate
 *   recordings/     ad-hoc recordings (unless settings.recordings.dir says otherwise)
 *
 * Writes are atomic (temp file + rename) so a crash mid-save cannot leave a
 * half-written file that fails to parse on the next boot.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(process.env.LOOKY_DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_SETTINGS = {
  ffmpeg: {
    path: process.env.LOOKY_FFMPEG || 'ffmpeg',
    probePath: process.env.LOOKY_FFPROBE || 'ffprobe',
    maxRestarts: 10,          // within restartWindowMs, after which the camera goes to 'error'
    restartWindowMs: 300000,
    restartDelayMs: 5000,
    rtspTransport: 'tcp',
    recycleAfterMs: 86400000, // preventive daily restart, done make-before-break
    watchdogIntervalMs: 60000,
    stallTimeoutMs: 10000,    // no video for this long => restart the pipeline
    idleTimeoutMs: 30000,     // keep a pipeline warm this long after its last viewer
    keepWarm: 'none',         // 'none' | 'sub' | 'all' — pipelines kept running with no viewers
    // RTSP multicast (see sources.js): 'off' = only sources whose transport is
    // 'multicast'; 'prefer' = every RTSP source tries multicast first.  Either
    // way a stream that gets no picture over multicast falls back to TCP.
    multicast: 'off',
  },
  webcodecs: {
    bufferMs: 150,
    audioBitrate: '64k',
    audioChannels: 1,
    maxFullMotionPanes: 10,
    // When panes use the main (High) stream instead of the substream (Low):
    //   'sub'        never — substreams only (default)
    //   'fullscreen' only a fullscreen pane or a single-camera layout
    //   'large'      also any pane at least mainMinWidth device pixels wide
    //   'main'       always
    // A pane's own HQ/LQ button and a view's quality override beat this.
    qualityPolicy: 'sub',
    mainMinWidth: 1280,
  },
  mjpeg: {
    enabled: true,
    fps: 5,
    quality: 5,
    scale: '640:-2',
  },
  recordings: {
    dir: '',
    retentionDays: 7,
    maxDurationMs: 7200000,
  },
};

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch (err) {
    if (err.code !== 'ENOENT') console.error(`[config] ${file} unreadable (${err.message}); using defaults`);
    return fallback;
  }
}

function writeJson(file, data) {
  const target = path.join(DATA_DIR, file);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object')
      ? deepMerge(base[k], v) : v;
  }
  return out;
}

class Store {
  constructor() {
    this.settings = deepMerge(DEFAULT_SETTINGS, readJson('settings.json', {}));
    this.cameras = readJson('cameras.json', null);
    this.layouts = readJson('layouts.json', null);
    this.firstBoot = this.cameras === null;
    if (!Array.isArray(this.cameras)) this.cameras = [];
    if (!Array.isArray(this.layouts)) this.layouts = [];
  }

  saveSettings(s) {
    // Merge rather than replace, so a client that does not know a key cannot delete it.
    this.settings = deepMerge(DEFAULT_SETTINGS, deepMerge(this.settings, s));
    writeJson('settings.json', this.settings);
  }
  saveCameras() { writeJson('cameras.json', this.cameras); }
  saveLayouts() {
    if (this.layouts.length === 0) this.layouts.push(defaultLayout());
    writeJson('layouts.json', this.layouts);
  }

  recordingsDir() {
    const d = this.settings.recordings.dir || path.join(DATA_DIR, 'recordings');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
}

const defaultLayout = () => ({ id: 'default', name: 'Default', description: '', gridType: '2x2', slots: {} });

/* --- Normalisation --------------------------------------------------------
   Cameras arrive from several shapes (the dashboard, the legacy XML files, the
   old camera-proxy cameras.json, a LookyLooky export).  Everything is reduced
   to one shape here so the rest of the server only ever sees that.          */

const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function slugify(s) {
  return String(s || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

function sourceType(url) {
  const u = String(url || '').toLowerCase();
  if (u.startsWith('rtsp://') || u.startsWith('rtsps://')) return 'rtsp';
  if (u.startsWith('http://') || u.startsWith('https://')) return 'http';
  if (u.startsWith('rtmp://')) return 'rtmp';
  if (u.startsWith('lavfi:') || u.startsWith('test:')) return 'test';
  return 'file';
}

function normaliseSource(s, fallbackLabel) {
  if (!s || !s.url) return null;
  const out = {
    label: String(s.label || fallbackLabel || 'main'),
    type: s.type && s.type !== 'auto' ? String(s.type) : sourceType(s.url),
    url: String(s.url).trim(),
    transport: ['udp', 'multicast'].includes(s.transport) ? s.transport : 'tcp',
  };
  // A separate RTSP address for multicast (ONVIF's RTP-Multicast URI), when the camera has one.
  if (s.multicastUrl && /^rtsps?:\/\//i.test(String(s.multicastUrl).trim())) out.multicastUrl = String(s.multicastUrl).trim();
  if (out.multicastUrl === out.url) delete out.multicastUrl;
  if (out.type !== sourceType(out.url) && !['rtsp', 'http', 'rtmp', 'test', 'file'].includes(out.type)) out.type = sourceType(out.url);
  if (s.transcode) out.transcode = true;
  if (s.params && typeof s.params === 'object') out.params = { ...s.params };
  if (s.auth && (s.auth.username || s.auth.password)) {
    out.auth = { username: String(s.auth.username || ''), password: String(s.auth.password || '') };
    if (s.auth.authType) out.auth.authType = String(s.auth.authType);
  }
  if (s.snapshotUrl) out.snapshotUrl = String(s.snapshotUrl);
  return out;
}

function normaliseCamera(c) {
  const id = String(c.id || '').trim();
  if (!ID_RE.test(id)) throw new Error(`Camera id "${id}" is not valid — use letters, digits, '.', '_' or '-'`);
  let sources = Array.isArray(c.sources) ? c.sources : (c.source ? [c.source] : []);
  sources = sources.map((s, i) => normaliseSource(s, i === 0 ? 'main' : 'sub')).filter(Boolean);
  const seen = new Set();
  sources = sources.filter((s) => (seen.has(s.label) ? false : seen.add(s.label)));
  if (sources.length === 0) throw new Error('A camera needs at least a main stream URL');
  return {
    id,
    name: String(c.name || id).trim() || id,
    group: String(c.group || '').trim(),
    enabled: c.enabled !== false,
    manufacturer: c.manufacturer ? String(c.manufacturer) : '',
    legacyId: c.legacyId != null ? String(c.legacyId) : undefined,
    sources,
  };
}

function normaliseLayout(l) {
  const slots = {};
  for (const [k, v] of Object.entries(l.slots || {})) {
    const idx = Number(k);
    if (!Number.isInteger(idx) || idx < 0 || idx > 63) continue;
    const cameraId = typeof v === 'string' ? v : v && v.cameraId;
    if (cameraId) slots[String(idx)] = { cameraId: String(cameraId), streamType: (v && v.streamType) || 'webcodecs' };
  }
  return {
    id: String(l.id || '').trim() || `layout-${Date.now()}`,
    name: String(l.name || l.id || 'Layout').trim(),
    description: String(l.description || ''),
    gridType: String(l.gridType || l.grid || '2x2'),
    slots,
  };
}

/* --- Import parsers ------------------------------------------------------- */

function xmlAttrs(tag) {
  const out = {};
  const re = /([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) out[m[1]] = decodeXml(m[2]);
  return out;
}
function decodeXml(s) {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** cameras.xml (legacy XML format): <camera-settings .../> and <camera ...><source .../></camera> */
function parseCamerasXml(text) {
  const result = { cameras: [], settings: null };
  const set = /<camera-settings\b([^>]*)\/?>/.exec(text);
  if (set) {
    const a = xmlAttrs(set[1]);
    const num = (k) => (a[k] !== undefined && a[k] !== '' && !isNaN(Number(a[k])) ? Number(a[k]) : undefined);
    const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
    result.settings = {
      ffmpeg: clean({
        path: a['ffmpeg-path'] || undefined,
        maxRestarts: num('max-restarts'),
        restartDelayMs: num('restart-delay'),
        rtspTransport: a['rtsp-transport'] || undefined,
        multicast: ['off', 'prefer'].includes(a.multicast) ? a.multicast : undefined,
        recycleAfterMs: num('recycle-after'),
        watchdogIntervalMs: num('watchdog-interval'),
      }),
      webcodecs: clean({
        audioBitrate: a['audio-bitrate'] || undefined,
        audioChannels: num('audio-channels'),
        bufferMs: num('buffer-ms'),
        maxFullMotionPanes: num('max-full-motion'),
      }),
      mjpeg: clean({
        enabled: a['mjpeg-enabled'] !== undefined ? a['mjpeg-enabled'] === 'true' : undefined,
        fps: num('mjpeg-fps'),
        quality: num('mjpeg-quality'),
        scale: a['mjpeg-scale'] || undefined,
      }),
      recordings: clean({
        dir: a['recordings-dir'] || undefined,
        retentionDays: num('recordings-retention-days'),
        maxDurationMs: num('recordings-max-duration'),
      }),
    };
    // A Windows ffmpeg path from the old install means nothing inside the container.
    if (result.settings.ffmpeg.path && /[\\:]/.test(result.settings.ffmpeg.path)) delete result.settings.ffmpeg.path;
    if (result.settings.recordings.dir && /[\\:]/.test(result.settings.recordings.dir)) delete result.settings.recordings.dir;
  }
  const camRe = /<camera\b([^>]*?)(\/>|>([\s\S]*?)<\/camera>)/g;
  let m;
  while ((m = camRe.exec(text))) {
    const a = xmlAttrs(m[1]);
    const sources = [];
    const srcRe = /<source\b([^>]*)\/?>/g;
    let s;
    while ((s = srcRe.exec(m[3] || ''))) {
      const sa = xmlAttrs(s[1]);
      if (sa.url) sources.push({ label: sa.label || (sources.length ? 'sub' : 'main'), url: sa.url, transport: sa.transport, type: sa.type, multicastUrl: sa['multicast-url'] });
    }
    if (!sources.length && a.source) sources.push({ label: 'main', url: a.source });
    const id = slugify(a['camera-id'] || a.id || a.name);
    if (!id || !sources.length) continue;
    result.cameras.push({
      id, name: a.name || id, group: a.group || '', enabled: a.enabled !== 'false',
      manufacturer: a.manufacturer || '', legacyId: a.id, sources,
    });
  }
  return result;
}

/** camera-layouts.xml (legacy XML format): <layout id name description grid><slot index camera stream/></layout> */
function parseLayoutsXml(text) {
  const layouts = [];
  const re = /<layout\b([^>]*?)(\/>|>([\s\S]*?)<\/layout>)/g;
  let m;
  while ((m = re.exec(text))) {
    const a = xmlAttrs(m[1]);
    const slots = {};
    const sr = /<slot\b([^>]*)\/?>/g;
    let s;
    while ((s = sr.exec(m[3] || ''))) {
      const sa = xmlAttrs(s[1]);
      if (sa.camera && sa.index !== undefined) slots[sa.index] = { cameraId: slugify(sa.camera), streamType: sa.stream || 'webcodecs' };
    }
    layouts.push({ id: a.id, name: a.name, description: a.description || '', gridType: a.grid || '2x2', slots });
  }
  return layouts;
}

/** The old standalone camera-proxy's cameras.json: HTTP cameras with params and session/basic auth. */
function parseProxyJson(obj) {
  return (obj.cameras || []).map((c) => ({
    id: slugify(c.id), name: c.name || c.id, enabled: c.enabled !== false, group: c.group || '',
    sources: [{
      label: 'main', type: 'http', url: c.url, params: c.params,
      auth: c.auth, snapshotUrl: c.snapshotUrl,
    }],
  }));
}

/**
 * Work out what a file is and return { cameras, layouts, settings }.
 * Accepts: cameras.xml, camera-layouts.xml, camera-proxy cameras.json,
 * a LookyLooky export ({ cameras, layouts, settings }), or a bare array.
 */
function parseImport(name, text) {
  const out = { cameras: [], layouts: [], settings: null };
  const t = String(text || '').replace(/^﻿/, '').trim();
  if (t.startsWith('<')) {
    if (/<camera-layouts\b|<layout\b/.test(t)) out.layouts = parseLayoutsXml(t);
    if (/<cameras\b|<camera\b|<camera-settings\b/.test(t)) Object.assign(out, { ...parseCamerasXml(t), layouts: out.layouts });
    return out;
  }
  let obj;
  try { obj = JSON.parse(t); } catch { throw new Error(`${name}: neither XML nor JSON`); }
  if (Array.isArray(obj)) { out.cameras = obj; return out; }
  if (obj.server && Array.isArray(obj.cameras) && obj.cameras.some((c) => c.url)) { out.cameras = parseProxyJson(obj); return out; }
  if (Array.isArray(obj.cameras)) out.cameras = obj.cameras;
  if (Array.isArray(obj.layouts)) out.layouts = obj.layouts;
  if (obj.settings && typeof obj.settings === 'object') out.settings = obj.settings;
  return out;
}

module.exports = {
  DATA_DIR, DEFAULT_SETTINGS, Store, deepMerge, defaultLayout,
  normaliseCamera, normaliseLayout, normaliseSource, sourceType, slugify,
  parseImport, parseCamerasXml, parseLayoutsXml, parseProxyJson, ID_RE,
};
