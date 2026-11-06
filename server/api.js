'use strict';
/**
 * REST API — everything the dashboard (cameras.html), the view page and the
 * camera wall call.  Endpoints that change things, or that reveal stream URLs
 * (which carry camera passwords), are admin endpoints: open when
 * LOOKY_ADMIN_PASSWORD is unset, Basic-auth protected when it is.
 */

const fs = require('fs');
const path = require('path');
const { sendJson, sendError, readJson, sse, sendFile, checkAuth } = require('./http-util');
const { normaliseCamera, normaliseLayout, parseImport, slugify, defaultLayout, DATA_DIR } = require('./config');
const { probe } = require('./probe');
const { discover } = require('./onvif');
const { scan } = require('./scan');
const { redact, hostOf } = require('./sources');

const VERSION = require('../package.json').version;

function register(router, ctx) {
  const { store, manager, recorder, hub, info } = ctx;
  const admin = (fn) => async (req, res, params, url) => {
    if (!checkAuth(req, res)) return;
    return fn(req, res, params, url);
  };

  /* --- info / stats ------------------------------------------------------- */

  router.get('/api/health', (req, res) => sendJson(res, 200, { ok: true }));

  router.get('/api/info', (req, res) => {
    const s = store.settings;
    sendJson(res, 200, {
      name: 'LookyLooky', version: VERSION, startedAt: info.startedAt,
      mjpegEnabled: s.mjpeg.enabled !== false,
      webcodecs: {
        bufferMs: s.webcodecs.bufferMs, maxFullMotionPanes: s.webcodecs.maxFullMotionPanes,
        audioBitrate: s.webcodecs.audioBitrate, audioChannels: s.webcodecs.audioChannels,
        qualityPolicy: s.webcodecs.qualityPolicy || 'sub', mainMinWidth: s.webcodecs.mainMinWidth || 1280,
      },
      httpPort: info.publicHttpPort, httpsPort: info.publicHttpsPort,
      tls: info.tls, authRequired: !!process.env.LOOKY_ADMIN_PASSWORD,
    });
  });

  router.get('/api/stats', (req, res) => {
    const st = manager.stats();
    sendJson(res, 200, {
      activeStreams: st.activeStreams,
      totalClients: hub.viewers.size,
      memory: { app: process.memoryUsage(), ffmpeg: manager.ffmpegMemory() },
      uptime: process.uptime(),
      processes: st.processes,
      sessions: st.sessions,
      mjpeg: st.mjpeg,
      recording: recorder.activeInfo(),
    });
  });

  /* --- cameras ------------------------------------------------------------ */

  router.get('/api/cameras', (req, res) => sendJson(res, 200, { cameras: manager.list() }));

  /** Test every source; returns [{label, ok, error, width, height, videoCodec}]. */
  async function testSources(cam) {
    return Promise.all(cam.sources.map(async (src) => {
      const r = await probe(src, store.settings, { key: `${cam.id}/${src.label}`, timeoutMs: 12000 });
      if (r.ok) manager.updateVariant(cam.id, src.label, { ...r, probedAt: Date.now() });
      return { label: src.label, ok: r.ok, error: r.error || null, width: r.width || null, height: r.height || null, videoCodec: r.videoCodec || null, audioCodec: r.audioCodec || null };
    }));
  }

  router.post('/api/cameras', admin(async (req, res) => {
    const body = await readJson(req);
    const cam = normaliseCamera(body);
    if (manager.camera(cam.id)) return sendError(res, 409, `A camera with id '${cam.id}' already exists`);
    if (!body.force) {
      const results = await testSources(cam);
      if (results.some((r) => !r.ok)) return sendJson(res, 422, { code: 'STREAM_TEST_FAILED', error: 'The stream could not be played', results });
    }
    manager.add(cam);
    sendJson(res, 201, { camera: cam });
  }));

  router.post('/api/cameras/recycle', admin((req, res) => {
    const r = manager.recycle();
    console.log(`[api] recycle: ${JSON.stringify(r)}`);
    sendJson(res, 200, r);
  }));

  router.post('/api/cameras/import', admin(async (req, res) => {
    const body = await readJson(req);
    const files = [];
    if (Array.isArray(body.files)) for (const f of body.files) files.push({ name: f.name || 'upload', text: String(f.content || '') });
    if (body.path) {
      const p = String(body.path);
      if (!fs.existsSync(p)) return sendError(res, 400, `Nothing at ${p} inside the container. Mount the folder (e.g. ./import:/import) or upload the files instead.`);
      if (fs.statSync(p).isDirectory()) {
        for (const n of fs.readdirSync(p)) {
          if (!/\.(xml|json)$/i.test(n)) continue;
          files.push({ name: n, text: fs.readFileSync(path.join(p, n), 'utf8') });
        }
      } else files.push({ name: path.basename(p), text: fs.readFileSync(p, 'utf8') });
    }
    if (!files.length) return sendError(res, 400, 'No files to import (cameras.xml, camera-layouts.xml, cameras.json or a LookyLooky export)');
    sendJson(res, 200, importFiles(files, { applySettings: body.applySettings !== false }));
  }));

  router.get('/api/export', admin((req, res) => {
    const body = JSON.stringify({ exportedAt: new Date().toISOString(), version: VERSION, settings: store.settings, cameras: store.cameras, layouts: store.layouts }, null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="lookylooky-export.json"' });
    res.end(body);
  }));

  router.post('/api/cameras/batch', admin(async (req, res) => {
    const body = await readJson(req);
    const items = Array.isArray(body.items) ? body.items : [];
    const emit = sse(res);
    let closed = false;
    req.on('close', () => { closed = true; });
    for (const item of items) {
      if (closed) break;
      await batchOne(item, body.group || '', emit).catch((err) => emit('item', { key: item.key, stage: 'failed', error: err.message }));
    }
    emit('done', { count: items.length });
    res.end();
  }));

  function nextCameraId() {
    const nums = store.cameras.map((c) => parseInt(String(c.id).replace(/\D/g, ''), 10) || 0);
    let n = Math.max(0, ...nums) + 1;
    while (manager.camera(`cam-${String(n).padStart(2, '0')}`)) n++;
    return `cam-${String(n).padStart(2, '0')}`;
  }

  async function batchOne(item, group, emit) {
    const key = item.key || item.ip;
    const transport = item.transport === 'udp' ? 'udp' : 'tcp';
    let sources = Array.isArray(item.sources) && item.sources.length
      ? item.sources.map((s) => ({ label: s.label, url: s.url, transport: s.transport || transport })) : null;
    let note = null;
    if (!sources && item.user) {
      emit('item', { key, stage: 'discovering' });
      try {
        const d = await discover({ host: item.ip, port: item.onvifPort || 80, user: item.user, pass: item.pass });
        if (d.suggested.main) {
          sources = [{ label: 'main', url: d.suggested.main, transport }];
          if (d.suggested.sub) sources.push({ label: 'sub', url: d.suggested.sub, transport });
        }
      } catch (err) {
        note = `ONVIF: ${err.message}`;
        if (err.auth) {
          return emit('item', { key, stage: 'failed', error: err.message, note: null, sources: null });
        }
      }
    }
    if (!sources) {
      const cred = item.user ? `${encodeURIComponent(item.user)}:${encodeURIComponent(item.pass || '')}@` : '';
      const p = String(item.path || '/stream1');
      sources = [{ label: 'main', url: `rtsp://${cred}${item.ip}:554${p.startsWith('/') ? p : '/' + p}`, transport }];
      note = (note ? note + ' · ' : '') + `tried the fallback path ${p}`;
    }
    const mainUrl = sources[0].url;
    const dup = store.cameras.find((c) => c.sources.some((s) => s.url === mainUrl));
    if (dup) return emit('item', { key, stage: 'failed', duplicate: true, error: `Already added as ${dup.id}` });

    const id = nextCameraId();
    const cam = normaliseCamera({ id, name: item.name || `Camera ${String(item.ip).split('.').pop()}`, group, sources });
    let results = [];
    let warning = null;
    if (!item.force) {
      emit('item', { key, stage: 'testing' });
      results = await testSources(cam);
      const main = results.find((r) => r.label === 'main');
      if (!main || !main.ok) {
        return emit('item', { key, stage: 'failed', error: main ? `Main stream: ${main.error}` : 'No main stream', results, sources, note });
      }
      const badSub = results.find((r) => r.label === 'sub' && !r.ok);
      if (badSub) {
        cam.sources = cam.sources.filter((s) => s.label !== 'sub');
        warning = `substream did not play (${badSub.error}) — added without it`;
      }
    }
    manager.add(cam);
    emit('item', { key, stage: 'added', id: cam.id, forced: !!item.force, results, warning, note });
  }

  router.get('/api/cameras/:id', admin((req, res, { id }) => {
    const cam = manager.camera(id);
    if (!cam) return sendError(res, 404, `No camera '${id}'`);
    sendJson(res, 200, { ...cam, ...manager.list().find((c) => c.id === id), sources: cam.sources });
  }));

  router.put('/api/cameras/:id', admin(async (req, res, { id }) => {
    const body = await readJson(req);
    const existing = manager.camera(id);
    if (!existing) return sendError(res, 404, `No camera '${id}'`);
    const candidate = normaliseCamera({ ...existing, ...body, id });
    const changed = JSON.stringify(candidate.sources) !== JSON.stringify(existing.sources);
    if (changed && !body.force) {
      const results = await testSources(candidate);
      if (results.some((r) => !r.ok)) return sendJson(res, 422, { code: 'STREAM_TEST_FAILED', error: 'The stream could not be played', results });
    }
    sendJson(res, 200, { camera: manager.update(id, body) });
  }));

  router.delete('/api/cameras/:id', admin((req, res, { id }) => {
    manager.remove(id);
    sendJson(res, 200, { ok: true });
  }));

  router.post('/api/cameras/:id/:action', admin((req, res, { id, action }) => {
    sendJson(res, 200, manager.control(id, action));
  }));

  /* --- layouts ------------------------------------------------------------ */

  router.get('/api/layouts', (req, res) => {
    if (!store.layouts.length) { store.layouts.push(defaultLayout()); store.saveLayouts(); }
    sendJson(res, 200, { layouts: store.layouts });
  });

  router.post('/api/layouts', admin(async (req, res) => {
    const body = await readJson(req);
    const layout = normaliseLayout({ ...body, id: body.id && !store.layouts.some((l) => l.id === body.id) ? body.id : `layout-${Date.now()}` });
    store.layouts.push(layout);
    store.saveLayouts();
    sendJson(res, 201, { layout });
  }));

  router.put('/api/layouts/:id', admin(async (req, res, { id }) => {
    const body = await readJson(req);
    const l = store.layouts.find((x) => x.id === id);
    if (!l) return sendError(res, 404, `No layout '${id}'`);
    Object.assign(l, normaliseLayout({ ...l, ...body, id }));
    store.saveLayouts();
    sendJson(res, 200, { layout: l });
  }));

  router.delete('/api/layouts/:id', admin((req, res, { id }) => {
    if (store.layouts.length <= 1) return sendError(res, 400, 'Cannot delete the last layout');
    const i = store.layouts.findIndex((x) => x.id === id);
    if (i < 0) return sendError(res, 404, `No layout '${id}'`);
    store.layouts.splice(i, 1);
    store.saveLayouts();
    sendJson(res, 200, { ok: true });
  }));

  /* --- settings ------------------------------------------------------------ */

  const getSettings = admin((req, res) => sendJson(res, 200, store.settings));
  const putSettings = admin(async (req, res) => {
    const body = await readJson(req);
    store.saveSettings(body);
    manager.applyKeepWarm();
    sendJson(res, 200, { ok: true, settings: store.settings, message: 'Settings saved. Changes apply as each stream next starts (Recycle Cameras applies them now).' });
  });
  router.get('/api/camera-settings', getSettings);
  router.put('/api/camera-settings', putSettings);
  router.get('/api/settings', getSettings);
  router.put('/api/settings', putSettings);

  /* --- recordings ---------------------------------------------------------- */

  router.get('/api/recordings', (req, res) => sendJson(res, 200, { active: recorder.activeInfo(), files: recorder.list(), lastError: recorder.lastError }));
  router.post('/api/recordings/start', admin(async (req, res) => {
    const body = await readJson(req);
    sendJson(res, 200, { active: await recorder.start(body) });
  }));
  router.post('/api/recordings/stop', admin(async (req, res) => {
    const filename = await recorder.stop();
    sendJson(res, 200, { ok: true, filename });
  }));
  router.get('/api/recordings/file/:name', admin((req, res, { name }, url) => {
    const p = recorder.resolve(name);
    if (!p) return sendError(res, 404, 'No such recording');
    sendFile(req, res, p, { download: url.searchParams.has('dl') });
  }));
  router.delete('/api/recordings/file/:name', admin((req, res, { name }) => {
    recorder.remove(name);
    sendJson(res, 200, { ok: true });
  }));

  /* --- discovery ------------------------------------------------------------ */

  router.post('/api/discover', admin(async (req, res) => {
    const b = await readJson(req);
    try {
      sendJson(res, 200, await discover({ host: String(b.host || '').trim(), port: Number(b.port) || 80, user: b.user || '', pass: b.pass || '' }));
    } catch (err) {
      sendJson(res, 200, { error: err.message, streams: [] });
    }
  }));

  router.get('/api/scan', admin(async (req, res, params, url) => {
    const base = url.searchParams.get('base') || '';
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(base)) return sendError(res, 400, 'base must be three octets, e.g. 192.168.1');
    const start = parseInt(url.searchParams.get('start'), 10) || 1;
    const end = parseInt(url.searchParams.get('end'), 10) || 254;
    const emit = sse(res);
    const signal = { aborted: false };
    req.on('close', () => { signal.aborted = true; });
    await scan(base, start, end, emit, signal);
    res.end();
  }));

  /* --- MJPEG / snapshot ---------------------------------------------------- */

  router.get('/stream/:id/mjpeg', (req, res, { id }) => {
    if (store.settings.mjpeg.enabled === false) return sendError(res, 404, 'The MJPEG endpoint is switched off in settings');
    const cam = manager.camera(id);
    if (!cam || !cam.enabled) return sendError(res, 404, `Camera '${id}' not found or stopped`);
    manager.mjpeg(id).addHttp(req, res);
  });

  router.get('/stream/:id/snapshot', async (req, res, { id }) => {
    if (store.settings.mjpeg.enabled === false) return sendError(res, 404, 'The MJPEG endpoint is switched off in settings');
    const cam = manager.camera(id);
    if (!cam || !cam.enabled) return sendError(res, 404, `Camera '${id}' not found or stopped`);
    const jpeg = await manager.mjpeg(id).snapshot(12000);
    if (!jpeg) return sendError(res, 504, 'No picture from the camera yet');
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    res.end(jpeg);
  });

  /* --- import ---------------------------------------------------------------- */

  function importFiles(files, { applySettings = true } = {}) {
    let added = 0, updated = 0, lAdded = 0, lUpdated = 0, settingsApplied = false;
    const errors = [];
    const touched = [];
    for (const f of files) {
      let parsed;
      try { parsed = parseImport(f.name, f.text); } catch (err) { errors.push(err.message); continue; }
      for (const c of parsed.cameras) {
        try {
          const cam = normaliseCamera(c);
          const existing = manager.camera(cam.id);
          if (existing) { manager.update(cam.id, cam); updated++; } else { store.cameras.push(cam); added++; }
          touched.push(cam.id);
        } catch (err) { errors.push(`${f.name}: ${err.message}`); }
      }
      for (const l of parsed.layouts) {
        const layout = normaliseLayout(l);
        const i = store.layouts.findIndex((x) => x.id === layout.id);
        if (i >= 0) { store.layouts[i] = layout; lUpdated++; } else { store.layouts.push(layout); lAdded++; }
      }
      if (parsed.settings && applySettings) { store.saveSettings(parsed.settings); settingsApplied = true; }
    }
    store.saveCameras();
    store.saveLayouts();
    for (const id of touched) { const c = manager.camera(id); if (c) manager.probeCamera(c); }
    manager.applyKeepWarm();
    const parts = [`${added} camera(s) added, ${updated} updated`, `${lAdded} layout(s) added, ${lUpdated} updated`];
    if (settingsApplied) parts.push('engine settings applied');
    if (errors.length) parts.push(`problems: ${errors.join('; ')}`);
    return { message: `Imported: ${parts.join(' · ')}.`, added, updated, layoutsAdded: lAdded, layoutsUpdated: lUpdated, errors };
  }

  return { importFiles };
}

module.exports = { register, VERSION, redact, hostOf, slugify, DATA_DIR };
