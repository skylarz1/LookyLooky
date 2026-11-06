/**
 * End-to-end check in a real browser (Playwright Chromium):
 *   node test/e2e.js [baseUrl]
 * Starts nothing — point it at a running LookyLooky with at least one camera
 * (the first-boot Test Pattern camera is enough).  Checks the dashboard, view
 * page and wall render live frames, that the PCM audio path works when
 * AudioDecoder is missing (iPad 6th gen), and the thumbnail-only fallback when
 * WebCodecs is missing.  Screenshots go to test/out/.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = process.argv[2] || 'https://localhost:8443';
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

async function page(browser, url, { init, viewport = { width: 1400, height: 900 }, wait = 6000 } = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport });
  if (init) await ctx.addInitScript(init);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(wait);
  return { p, ctx, errors };
}

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    // 1. Dashboard
    {
      const { p, ctx, errors } = await page(browser, '/cameras.html');
      const probe = await p.evaluate(() => window.__claudiferProbe && window.__claudiferProbe());
      const panes = probe?.panes || [];
      const live = panes.filter((x) => x.framesRendered > 0 || x.effectiveMode === 'thumbnail');
      check('dashboard: grid mounted with panes', panes.length > 0, `${panes.length} pane(s)`);
      check('dashboard: frames rendered', panes.some((x) => x.framesRendered > 10), panes.map((x) => `${x.cameraId}:${x.effectiveMode}:${x.framesRendered}f`).join(' '));
      check('dashboard: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
      await p.screenshot({ path: path.join(OUT, 'dashboard.png') });
      await ctx.close();
    }
    // 2. View page
    {
      const { p, ctx, errors } = await page(browser, '/camera-view.html?layout=default');
      const probe = await p.evaluate(() => {
        const g = window.__claudiferGrid; if (!g) return null;
        return [...g._panes.values()].map((x) => ({ id: x.cameraId, f: x._client?.getStats?.().framesRendered || 0, mode: x.mode }));
      });
      check('view page: frames rendered', !!probe && probe.some((x) => x.f > 10), JSON.stringify(probe));
      check('view page: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
      await p.screenshot({ path: path.join(OUT, 'view.png') });
      await ctx.close();
    }
    // 3. Wall (iPad-sized viewport)
    {
      const { p, ctx, errors } = await page(browser, '/wall.html', { viewport: { width: 1024, height: 768 } });
      const st = await p.evaluate(() => {
        const w = window.__claudiferWall; if (!w || !w.grid) return null;
        return { selected: w.selectedID, panes: [...w.grid._panes.values()].map((x) => ({ id: x.cameraId, mode: x.effectiveMode, f: x._client?.getStats?.().framesRendered ?? x._client?.getStats?.().frames ?? 0 })) };
      });
      check('wall: built and main pane live', !!st && st.panes.some((x) => x.mode === 'webcodecs' && x.f > 10), JSON.stringify(st));
      check('wall: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
      await p.screenshot({ path: path.join(OUT, 'wall.png') });
      await ctx.close();
    }
    // 4. "iPad 6th gen": VideoDecoder but no AudioDecoder -> PCM audio
    {
      const { p, ctx, errors } = await page(browser, '/camera-view.html?layout=default', {
        init: () => { delete window.AudioDecoder; delete window.AudioData; delete window.EncodedAudioChunk; },
      });
      // Unmute the first pane as a tap would.
      await p.mouse.click(300, 300);
      const res = await p.evaluate(async () => {
        const g = window.__claudiferGrid; const pane = [...g._panes.values()][0];
        g.setFocusedCamera(pane.cameraId, 1, false);
        await new Promise((r) => setTimeout(r, 3000));
        const c = pane._client;
        return { mode: c?._audioMode, scheduled: c?.getStats().audioScheduled, frames: c?.getStats().framesRendered, ctx: c?._audioCtx?.state };
      });
      check('iPad path: audio via PCM fallback', res.mode === 'pcm' && res.scheduled > 10, JSON.stringify(res));
      check('iPad path: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
      await ctx.close();
    }
    // 4b. Normal browser, unmuted: Opus path
    {
      const { p, ctx } = await page(browser, '/camera-view.html?layout=default');
      await p.mouse.click(300, 300);
      const res = await p.evaluate(async () => {
        const g = window.__claudiferGrid; const pane = [...g._panes.values()][0];
        g.setFocusedCamera(pane.cameraId, 1, false);
        await new Promise((r) => setTimeout(r, 3000));
        const c = pane._client;
        return { mode: c?._audioMode, scheduled: c?.getStats().audioScheduled, ctx: c?._audioCtx?.state };
      });
      check('desktop path: audio via Opus/AudioDecoder', res.mode === 'opus' && res.scheduled > 10, JSON.stringify(res));
      await ctx.close();
    }
    // 5. No WebCodecs at all -> thumbnail-only board with banner
    {
      const { p, ctx, errors } = await page(browser, '/camera-view.html?layout=default&insecure=1', {
        init: () => { delete window.VideoDecoder; delete window.AudioDecoder; delete window.EncodedVideoChunk; },
      });
      const res = await p.evaluate(() => ({
        banner: !!document.querySelector('.looky-banner'),
        panes: [...window.__claudiferGrid._panes.values()].map((x) => ({ mode: x.mode, frames: x._client?.getStats?.().frames || 0 })),
      }));
      check('no-WebCodecs: thumbnails render + banner', res.banner && res.panes.every((x) => x.mode === 'thumbnail') && res.panes.some((x) => x.frames > 0), JSON.stringify(res));
      check('no-WebCodecs: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
      await p.screenshot({ path: path.join(OUT, 'thumbnails-only.png') });
      await ctx.close();
    }
    // 6. Glass-to-glass-ish latency: server pts vs client render time, via the playout lead
    {
      const { p, ctx } = await page(browser, '/camera-view.html?layout=default', { wait: 8000 });
      const lat = await p.evaluate(() => {
        const c = [...window.__claudiferGrid._panes.values()][0]._client;
        return { bufferMs: c._bufferMs, reanchors: c.getStats().reanchors || 0, queue: c.getStats().videoQueue, dropped: c.getStats().framesDropped, rendered: c.getStats().framesRendered };
      });
      check('playout queue stays near live', lat.queue <= 8, JSON.stringify(lat));
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
