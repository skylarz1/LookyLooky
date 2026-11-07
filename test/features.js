/**
 * Feature checks: multi-camera audio, zoom (wheel + pinch + reset), quality.
 *   node test/features.js https://localhost:8443 [http://localhost:8080]
 * Creates four test-pattern cameras with different tones (300/500/700/900 Hz)
 * and a 2x2 layout "feat" through the API, then drives Chromium.
 */
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'https://localhost:8443';
const API = process.argv[3] || BASE.replace('https:', 'http:').replace(/:\d+$/, ':8080');
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const TONES = [300, 500, 700, 900];

async function api(method, path, body) {
  const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json().catch(() => ({}));
}

/** In the page: route every pane's audio also into one analyser and report which tones are present. */
async function measureTones(p) {
  return p.evaluate(async (tones) => {
    const panes = [...window.__claudiferGrid._panes.values()];
    for (const pane of panes) pane._client.setMuted(false);           // everyone audible at once
    await new Promise((r) => setTimeout(r, 2500));
    const clients = panes.map((x) => x._client);
    const ctx = clients.find((c) => c._audioCtx)?._audioCtx;
    if (!ctx) return { error: 'no audio context' };
    const an = ctx.createAnalyser(); an.fftSize = 16384; an.smoothingTimeConstant = 0.6;
    for (const c of clients) c._audioGain?.connect(an);
    await new Promise((r) => setTimeout(r, 1500));
    const bins = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(bins);
    const hz = ctx.sampleRate / an.fftSize;
    const at = (f) => Math.max(...[-2, -1, 0, 1, 2].map((d) => bins[Math.round(f / hz) + d]));
    const noise = [1100, 1300, 1700, 2300].map(at).reduce((a, b) => a + b, 0) / 4;
    return {
      ctx: ctx.state, rate: ctx.sampleRate, mode: clients[0]._audioMode,
      levels: Object.fromEntries(tones.map((t) => [t, Math.round(at(t))])), noise: Math.round(noise),
      scheduled: clients.map((c) => c.getStats().audioScheduled),
    };
  }, TONES);
}

(async () => {
  for (let i = 0; i < 4; i++) {
    await api('POST', '/api/cameras', { id: `tone${i}`, name: `Tone ${TONES[i]}`, group: 'Feature test', force: true,
      sources: [{ label: 'main', url: `test:960x540@25?tone=${TONES[i]}` }, { label: 'sub', url: `test:480x270@25?tone=${TONES[i]}` }] });
  }
  await api('POST', '/api/layouts', { id: 'feat', name: 'feat', gridType: '2x2',
    slots: { 0: { cameraId: 'tone0' }, 1: { cameraId: 'tone1' }, 2: { cameraId: 'tone2' }, 3: { cameraId: 'tone3' } } });

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const open = async (url, { init, viewport = { width: 1280, height: 800 }, touch = false } = {}) => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport, hasTouch: touch });
    if (init) await ctx.addInitScript(init);
    const p = await ctx.newPage();
    const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(BASE + url); await p.waitForTimeout(5000);
    return { p, ctx, errors };
  };

  // ── 1. Multi-camera audio, Opus (Chrome / Safari 26+) ──
  {
    const { p, ctx } = await open('/camera-view.html?layout=feat');
    await p.mouse.click(5, 5);
    const r = await measureTones(p);
    const heard = TONES.filter((t) => r.levels?.[t] > r.noise + 20);
    check('audio (Opus): all four cameras audible at once', heard.length === 4, JSON.stringify(r));
    await ctx.close();
  }
  // ── 2. Multi-camera audio, PCM fallback (iPad 6th gen / Safari < 26) ──
  {
    const { p, ctx } = await open('/camera-view.html?layout=feat', { init: () => { delete window.AudioDecoder; delete window.EncodedAudioChunk; delete window.AudioData; } });
    await p.mouse.click(5, 5);
    const r = await measureTones(p);
    const heard = TONES.filter((t) => r.levels?.[t] > r.noise + 20);
    check('audio (PCM, iPad path): all four cameras audible at once', r.mode === 'pcm' && heard.length === 4, JSON.stringify(r));
    await ctx.close();
  }
  // ── 3. Zoom: wheel toward the cursor ──
  {
    const { p, ctx, errors } = await open('/camera-view.html?layout=feat');
    const box = await p.locator('#card-tone0 .video-wrap').boundingBox();
    const px = box.x + box.width * 0.75, py = box.y + box.height * 0.25;
    await p.mouse.move(px, py);
    for (let i = 0; i < 5; i++) await p.mouse.wheel(0, -120);
    await p.waitForTimeout(300);
    const z = await p.evaluate(() => { const pane = window.__claudiferGrid.getPane('tone0'); return { ...pane._zoom, t: document.getElementById(pane.canvasId).style.transform, badge: document.getElementById(pane.zoomBadgeId).textContent }; });
    // The content point under the cursor before zooming (0.75, 0.25) must still be under it: fx = x + 0.75*s
    const fx = z.x + 0.75 * z.s, fy = z.y + 0.25 * z.s;
    check('zoom: wheel zooms in toward the cursor', z.s > 2 && Math.abs(fx - 0.75) < 0.01 && Math.abs(fy - 0.25) < 0.01, JSON.stringify(z));
    for (let i = 0; i < 20; i++) await p.mouse.wheel(0, 200);
    const back = await p.evaluate(() => window.__claudiferGrid.getPane('tone0')._zoom.s);
    check('zoom: wheel back out stops at 1×', back === 1, `scale ${back}`);
    check('zoom: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  // ── 4. Zoom: two-finger pinch (iPad) ──
  {
    const { p, ctx } = await open('/camera-view.html?layout=feat', { touch: true, viewport: { width: 1024, height: 768 } });
    const box = await p.locator('#card-tone1 .video-wrap').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const cdp = await ctx.newCDPSession(p);
    const pts = (d) => [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(20) });
    for (let d = 25; d <= 100; d += 5) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const z = await p.evaluate(() => window.__claudiferGrid.getPane('tone1')._zoom);
    check('zoom: pinch out zooms the pane', z.s > 3, JSON.stringify(z));
    await ctx.close();
  }
  // ── 5. Zoom resets when the wall's main pane changes ──
  {
    const { p, ctx } = await open('/wall.html?layout=feat', { viewport: { width: 1024, height: 768 } });
    const main = await p.evaluate(() => window.__claudiferWall.selectedID);
    const box = await p.locator(`#card-${main} .video-wrap`).boundingBox();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 4; i++) await p.mouse.wheel(0, -120);
    const before = await p.evaluate((id) => window.__claudiferGrid?.getPane?.(id)?._zoom.s ?? window.__claudiferWall.grid.getPane(id)._zoom.s, main);
    await p.click('#card-tone2');
    await p.waitForTimeout(500);
    const after = await p.evaluate((id) => window.__claudiferWall.grid.getPane(id)._zoom.s, main);
    const sel = await p.evaluate(() => window.__claudiferWall.selectedID);
    check('zoom: resets when another camera becomes main', before > 1 && after === 1 && sel === 'tone2', `main ${main} zoom ${before.toFixed(2)} → ${after}, now main: ${sel}`);
    await ctx.close();
  }
  // ── 6. Quality: policy, pane button, view override ──
  {
    const { p, ctx, errors } = await open('/cameras.html');
    await p.selectOption('#layoutSelect', 'feat'); await p.waitForTimeout(5000);
    const q = () => p.evaluate(() => [...window.__claudiferGrid._panes.values()].map((x) => `${x.cameraId}:${x.effectiveQuality}`).join(' '));
    const policy = await q();
    check('quality: server policy default is substreams only', !/main/.test(policy), policy);
    // Hover shows the HQ/LQ control; click it.
    await p.hover('#card-tone0 .video-wrap'); await p.waitForTimeout(400);   // let the fade-in finish
    const vis = await p.evaluate(() => getComputedStyle(document.querySelector('#card-tone0 .quality-ctl')).opacity);
    await p.click('#card-tone0 .quality-btn'); await p.waitForTimeout(3500);
    const pane = await p.evaluate(() => { const x = window.__claudiferGrid.getPane('tone0'); return { q: x._currentQuality, label: document.querySelector('#card-tone0 .quality-btn').textContent, manual: document.querySelector('#card-tone0 .quality-ctl').classList.contains('manual'), frames: x._client.getStats().framesRendered }; });
    check('quality: hover shows HQ/LQ, click switches that pane to High', vis === '1' && pane.q === 'main' && pane.label === 'HQ' && pane.manual && pane.frames > 0, JSON.stringify({ vis, ...pane }));
    const others = await q();
    check('quality: other panes stay Low', /tone1:sub/.test(others) && /tone3:sub/.test(others), others);
    // View-wide High
    await p.selectOption('#qualitySelect', 'main'); await p.waitForTimeout(3500);
    const all = await q();
    check('quality: view override High switches every pane', !/:sub/.test(all), all);
    // Pane "A" returns tone0 to automatic; view back to Auto → all Low
    await p.hover('#card-tone0 .video-wrap'); await p.click('#card-tone0 .quality-auto');
    await p.selectOption('#qualitySelect', ''); await p.waitForTimeout(3500);
    const auto = await q();
    check('quality: back to Auto returns everything to the policy', !/:main/.test(auto), auto);
    // Policy 'large': at 1280x800 a 2x2 pane is ~620 px wide < 1280 → Low; threshold 500 → High
    await p.evaluate(() => window.__claudiferGrid.setQualityPolicy('large', 500)); await p.waitForTimeout(3500);
    const large = await q();
    check('quality: "large" policy gives big panes High', !/:sub/.test(large), large);
    check('quality: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  // ── 7. Per-pane speakers ──
  {
    const heard = (p) => p.evaluate(async (tones) => {
      const panes = [...window.__claudiferGrid._panes.values()];
      await new Promise((r) => setTimeout(r, 2500));
      const clients = panes.map((x) => x._client).filter(Boolean);
      const ctx = clients.find((c) => c._audioCtx)?._audioCtx;
      if (!ctx) return [];
      const an = ctx.createAnalyser(); an.fftSize = 16384; an.smoothingTimeConstant = 0.5;
      for (const c of clients) c._audioGain?.connect(an);
      await new Promise((r) => setTimeout(r, 1200));
      const bins = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(bins);
      const hz = ctx.sampleRate / an.fftSize;
      const at = (f) => Math.max(...[-2, -1, 0, 1, 2].map((d) => bins[Math.round(f / hz) + d]));
      for (const c of clients) { try { c._audioGain?.disconnect(an); } catch {} }
      return tones.filter((t) => at(t) > -70);
    }, TONES);
    const { p, ctx, errors } = await open('/cameras.html');
    await p.selectOption('#layoutSelect', 'feat'); await p.waitForTimeout(5000);
    // A clean slate: nothing focused, master muted.
    await p.evaluate(() => { window.__claudiferGrid.setFocusedCamera(null, 1, true); });
    const none = await heard(p);
    check('speakers: nothing pressed → silent', none.length === 0, `heard ${JSON.stringify(none)}`);
    for (const id of ['tone1', 'tone3']) { await p.hover(`#card-${id} .video-wrap`); await p.waitForTimeout(300); await p.click(`#card-${id} .speaker-btn`); }
    const two = await heard(p);
    const btn = await p.evaluate(() => ['tone0', 'tone1', 'tone2', 'tone3'].map((id) => document.querySelector(`#card-${id} .speaker-btn`).className).join(' | '));
    check('speakers: two pane speakers → exactly those two cameras heard', JSON.stringify(two) === JSON.stringify([500, 900]), `heard ${JSON.stringify(two)}; buttons: ${btn}`);
    // Master: unmute (focus none) then mute again → clears the pane speakers.
    await p.click('#globalMuteBtn'); await p.click('#globalMuteBtn');
    const cleared = await heard(p);
    check('speakers: top mute button silences pane speakers too', cleared.length === 0, `heard ${JSON.stringify(cleared)}`);
    // Normal single-focus behaviour still intact: focus tone2 + unmute master → only tone2.
    await p.evaluate(() => { window.__claudiferGrid.setFocusedCamera('tone2', 1, false); });
    const focus = await heard(p);
    check('speakers: default single focused audio unchanged', JSON.stringify(focus) === JSON.stringify([700]), `heard ${JSON.stringify(focus)}`);
    // Focus + one extra.
    await p.hover('#card-tone0 .video-wrap'); await p.waitForTimeout(300); await p.click('#card-tone0 .speaker-btn');
    const plus = await heard(p);
    check('speakers: focused camera plus a pane speaker', JSON.stringify(plus) === JSON.stringify([300, 700]), `heard ${JSON.stringify(plus)}`);
    check('speakers: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  // ── 8. Wall: a preview's speaker promotes it to full motion and plays it with the main pane ──
  {
    const { p, ctx, errors } = await open('/wall.html?layout=feat', { viewport: { width: 1024, height: 768 } });
    const main = await p.evaluate(() => window.__claudiferWall.selectedID);
    const prev = ['tone1', 'tone2', 'tone3'].find((id) => id !== main);
    const modeBefore = await p.evaluate((id) => window.__claudiferWall.grid.getPane(id).effectiveMode, prev);
    await p.hover(`#card-${prev} .video-wrap`); await p.waitForTimeout(300);
    await p.click(`#card-${prev} .speaker-btn`); await p.waitForTimeout(4000);
    const st = await p.evaluate((id) => { const g = window.__claudiferWall.grid; const x = g.getPane(id); return { mode: x.effectiveMode, audible: g.isPaneAudible(id), muted: x._client?._muted }; }, prev);
    check('wall: preview speaker → full motion and audible', modeBefore === 'thumbnail' && st.mode === 'webcodecs' && st.audible && st.muted === false, JSON.stringify({ modeBefore, ...st }));
    check('wall: no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  // ── 9. Network errors: a pane with no picture says why instead of looking stalled ──
  // 192.0.2.1 is TEST-NET (never answers); 127.0.0.1:1 is a live host with nothing on the port.
  await api('POST', '/api/cameras', { id: 'lost', name: 'Lost', group: 'Feature test', force: true, sources: [{ label: 'main', url: 'rtsp://192.0.2.1:554/stream' }] });
  await api('POST', '/api/cameras', { id: 'shut', name: 'Shut', group: 'Feature test', force: true, sources: [{ label: 'main', url: 'rtsp://127.0.0.1:1/stream' }] });
  await api('POST', '/api/layouts', { id: 'neterr', name: 'neterr', gridType: '2x2',
    slots: { 0: { cameraId: 'tone0' }, 1: { cameraId: 'lost' }, 2: { cameraId: 'shut' } } });
  const cover = (p, id) => p.evaluate((cid) => {
    const el = document.querySelector(`#card-${cid} .stream-problem`);
    return el && !el.hidden ? el.innerText.replace(/\s+/g, ' ').trim() : '';
  }, id);
  const SINCE = /No video since \d{1,2}:\d{2}\s?[AP]M/;
  {
    const { p, ctx, errors } = await open('/camera-view.html?layout=neterr');
    await p.waitForTimeout(10000);
    const lost = await cover(p, 'lost'), shut = await cover(p, 'shut'), tone = await cover(p, 'tone0');
    check('network: unreachable camera → "Network error / can’t be reached / since h:mm AM"',
      /^Network error/.test(lost) && /can.t be reached/.test(lost) && SINCE.test(lost), lost || 'no cover');
    check('network: closed port → "Camera error" with the reason', /^Camera error/.test(shut) && /refused/.test(shut), shut || 'no cover');
    check('network: a live pane has no cover', tone === '', tone);
    const cams = (await api('GET', '/api/cameras')).cameras || [];
    const kind = (id) => cams.find((c) => c.id === id)?.problem?.kind;
    check('network: /api/cameras reports the problem kind', kind('lost') === 'network' && kind('shut') === 'camera' && !kind('tone0'),
      JSON.stringify(cams.filter((c) => ['lost', 'shut'].includes(c.id)).map((c) => c.problem)));
    // Kinds the dev instance can't produce for real: the whole camera network
    // down (other cameras play here), and this device losing the server.
    const down = await p.evaluate(() => {
      const pane = window.__claudiferGrid.getPane('tone0');
      pane._onStatus('problem', { kind: 'network-down', since: Date.now() - 3 * 3600e3, text: '' });
      const t = document.querySelector('#card-tone0 .stream-problem').innerText;
      pane._onStatus('streaming');
      return { t, hidden: document.querySelector('#card-tone0 .stream-problem').hidden };
    });
    check('network: "camera network down" cover, cleared by the next picture',
      /No camera can be reached/.test(down.t) && /No video since /.test(down.t) && down.hidden, JSON.stringify(down));
    await p.evaluate(() => window.__claudiferGrid.getPane('tone0')._onStatus('reconnecting'));
    await p.waitForTimeout(10500);
    const lostServer = await cover(p, 'tone0');
    await p.evaluate(() => window.__claudiferGrid.getPane('tone0')._onStatus('subscribed'));
    check('network: socket to the server down 10 s → "Lost the connection", gone on reconnect',
      /Lost the connection to LookyLooky/.test(lostServer) && (await cover(p, 'tone0')) === '', lostServer);
    check('network: no page errors', errors.length === 0, errors.join(' | '));

    // The dashboard header, while the view above still watches the cameras.
    const d = await open('/cameras.html');
    await d.p.waitForTimeout(5000);
    const alert = await d.p.evaluate(() => { const el = document.getElementById('networkAlert'); return el && !el.hidden ? el.textContent : ''; });
    check('network: dashboard header says how many cameras can’t be reached', /^Network error: 1 camera can.t be reached \(since \d{1,2}:\d{2}\s?[AP]M\)$/.test(alert), alert || 'hidden');
    await d.ctx.close();
    await ctx.close();
  }
  // ── 10. The same on the wall, where the previews are JPEG thumbnails ──
  {
    const { p, ctx, errors } = await open('/wall.html?layout=neterr', { viewport: { width: 1024, height: 768 } });
    await p.waitForTimeout(8000);
    const st = await p.evaluate(() => {
      const w = window.__claudiferWall;
      return { main: w.selectedID, lostMode: w.grid.getPane('lost')?.effectiveMode };
    });
    const lost = await cover(p, 'lost');
    check('network: wall thumbnail of an unreachable camera says so', st.lostMode === 'thumbnail' && /^Network error/.test(lost) && SINCE.test(lost),
      `${JSON.stringify(st)} ${lost || 'no cover'}`);
    check('network (wall): no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
  await api('DELETE', '/api/layouts/neterr');
  for (const id of ['lost', 'shut']) await api('DELETE', `/api/cameras/${id}`);
  await browser.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
