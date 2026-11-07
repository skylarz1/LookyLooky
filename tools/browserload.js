#!/usr/bin/env node
'use strict';
/**
 * Real-browser load test: opens --pages view boards in headless Chromium
 * (Playwright, a dev dependency) and every --every seconds prints what those
 * browsers report to the server: frames drawn, frames dropped, decoder
 * backlog, and how long frames took from the server to arrive and to reach
 * the screen.  Run tools/loadtest.js at the same time for protocol-level
 * viewers in bulk; this one shows what real decoders and real playout make
 * of the same load.
 *
 *   node tools/browserload.js --url https://looky.local --ip 192.168.1.124 --layout default --quality low --pages 4 --minutes 10
 *
 * Options:
 *   --url --ip --minutes --every --out --insecure   as in loadtest.js
 *   --layout   layout id or name for /camera-view.html (required)
 *   --quality  low | high: pins every pane to the substream or the main stream (low)
 *   --pages    how many boards (browser contexts) to open (2)
 *   --headed   show the browsers
 * Needs LOOKY_ADMIN_PASSWORD to read the viewer reports from /api/stats.
 *
 * Headless Chromium decodes in software (no GPU), and has no H.265 decoder
 * at all, so H.265 panes show as errors here though they play in a real
 * browser.  What it measures is the server and the network under real
 * playout, plus one machine's software decoding.
 */

const fs = require('fs');
const https = require('https');
const http = require('http');
const dns = require('dns');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
  else { args[a.slice(2)] = next; i++; }
}
if (!args.layout) { console.error('--layout is required (a layout id or name)'); process.exit(1); }
const BASE = new URL(args.url || 'https://looky.local');
const PAGES = Number(args.pages || 2);
const MINUTES = Number(args.minutes || 5);
const EVERY_S = Number(args.every || 10);
const QUALITY = args.quality === 'high' ? 'high' : 'low';
const OUT = args.out || `browserload-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
const PASSWORD = process.env.LOOKY_ADMIN_PASSWORD || '';

const ET = { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true };
const clock = (ms = Date.now()) => new Date(ms).toLocaleTimeString('en-US', ET);
const lookup = args.ip
  ? (host, opts, cb) => { if (typeof opts === 'function') { cb = opts; opts = {}; } if (opts && opts.all) cb(null, [{ address: args.ip, family: 4 }]); else cb(null, args.ip, 4); }
  : dns.lookup;

function stats() {
  const mod = BASE.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const headers = { Authorization: 'Basic ' + Buffer.from('admin:' + PASSWORD).toString('base64') };
    mod.get(new URL('/api/stats?viewers=1', BASE), { headers, lookup, servername: BASE.hostname, rejectUnauthorized: !args.insecure, timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(`HTTP ${res.statusCode}`))));
    }).on('error', reject);
  });
}

const med = (list) => { const s = list.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const max = (list) => { const s = list.filter((x) => x != null); return s.length ? Math.max(...s) : null; };

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); } catch {
    console.error('Playwright is not installed: npm install (it is a dev dependency), then npx playwright install chromium');
    process.exit(1);
  }
  const launchArgs = ['--autoplay-policy=no-user-gesture-required'];
  if (args.ip) launchArgs.push(`--host-resolver-rules=MAP ${BASE.hostname} ${args.ip}`);
  const browser = await chromium.launch({ headless: !args.headed, args: launchArgs });
  const url = new URL('/camera-view.html', BASE);
  url.searchParams.set('layout', args.layout);
  url.searchParams.set('quality', QUALITY);
  const pages = [];
  for (let i = 0; i < PAGES; i++) {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: !!args.insecure });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`page ${i + 1}: ${e.message}`));
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    pages.push(page);
  }
  console.log(`${clock()}  ${PAGES} boards of layout "${args.layout}" at ${QUALITY} quality, ${MINUTES} min: ${url.href}`);
  console.log('time         panes  reporting  fps (median)  dropped/5s  decode q max  arrival p50/p95 ms  screen p50/p95 ms  software  errors');

  const windows = [];
  const tick = async () => {
    let s;
    try { s = await stats(); } catch (err) { console.log(`${clock()}  stats unavailable: ${err.message}`); return; }
    const mine = (s.viewers || []).filter((v) => /HeadlessChrome|Playwright/.test(v.userAgent) && v.cameraId);
    const reps = mine.map((v) => v.report).filter(Boolean);
    let errors = 0;
    for (const p of pages) errors += await p.evaluate(() => document.querySelectorAll('.status-dot.error').length).catch(() => 0);
    const row = {
      at: Date.now(), panes: mine.length, reporting: reps.length,
      fps: med(reps.map((r) => r.fps)), dropped: reps.reduce((a, r) => a + (r.dropped || 0), 0), decodeQueueMax: max(reps.map((r) => r.decodeQueue)),
      arrivalP50: med(reps.map((r) => r.arrival && r.arrival.p50)), arrivalP95: max(reps.map((r) => r.arrival && r.arrival.p95)),
      screenP50: med(reps.map((r) => r.render && r.render.p50)), screenP95: max(reps.map((r) => r.render && r.render.p95)),
      software: reps.filter((r) => r.software).length, errors,
      host: s.host ? { cpuPct: s.host.hostCpuPct, appCpuPct: s.host.app.cpuPct, ffmpegCpuPct: s.host.ffmpeg.cpuPct, loopP99Ms: s.host.app.loop.p99Ms } : null,
    };
    windows.push(row);
    const pad = (v, n) => String(v ?? '–').padStart(n);
    console.log(`${clock().padEnd(12)} ${pad(row.panes, 5)}  ${pad(row.reporting, 9)}  ${pad(row.fps, 12)}  ${pad(row.dropped, 10)}  ${pad(row.decodeQueueMax, 12)}  ${pad(`${row.arrivalP50}/${row.arrivalP95}`, 18)}  ${pad(`${row.screenP50}/${row.screenP95}`, 17)}  ${pad(row.software, 8)}  ${pad(errors, 6)}`);
  };
  const timer = setInterval(tick, EVERY_S * 1000);
  await new Promise((r) => setTimeout(r, MINUTES * 60000));
  clearInterval(timer);
  await tick();
  fs.writeFileSync(OUT, JSON.stringify({ url: url.href, pages: PAGES, quality: QUALITY, minutes: MINUTES, windows }, null, 2));
  console.log(`Results: ${OUT}`);
  await browser.close();
  process.exit(0);
})();
