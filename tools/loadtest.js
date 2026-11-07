#!/usr/bin/env node
'use strict';
/**
 * Many-viewer load test for a running LookyLooky.
 *
 *   node tools/loadtest.js --url https://looky.local --variant sub --per 10 --minutes 10
 *
 * Opens --per viewers on every camera (or --cameras a,b,c), the way a browser
 * pane does, and every --every seconds prints one line: viewers connected,
 * frames per second received, how late frames arrive, stalls, and the
 * server's own load (from /api/stats).  At the end it prints a summary, with
 * the lag trend (ms per minute; anything clearly above 0 is lag building up),
 * and writes everything to --out.
 *
 * Lag here is measured the way the statistics page measures a browser's
 * Arrival: a ping maps this machine's clock onto the server's, and each
 * frame's arrival on that clock minus its PTS, minus the stream's own input
 * delay (ptsLagMs), is the time from the server sending it to it arriving.
 *
 * Options:
 *   --url        base URL (https://looky.local)
 *   --ip         connect to this address instead of resolving the host (e.g. 192.168.1.124)
 *   --variant    sub | main (sub)
 *   --per        viewers per camera (5)
 *   --cameras    comma-separated camera ids (default: every enabled camera)
 *   --minutes    how long to run (5)
 *   --ramp       seconds over which to open the viewers (20)
 *   --every      seconds per report line (10)
 *   --out        JSON results file (loadtest-<time>.json)
 *   --insecure   don't verify the server's certificate (otherwise NODE_EXTRA_CA_CERTS=<ca.crt>)
 *   Admin password for /api/stats?viewers: env LOOKY_ADMIN_PASSWORD (user "admin").
 *
 * The viewers drain their sockets as fast as this machine can; a slow
 * machine or link shows up as rising lag on every stream at once.  Run it
 * from a host with headroom, and compare its own CPU (printed) to be sure.
 */

const fs = require('fs');
const os = require('os');
const dns = require('dns');
const https = require('https');
const http = require('http');
const WebSocket = require('ws');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
  else { args[a.slice(2)] = next; i++; }
}
const BASE = new URL(args.url || 'https://looky.local');
const VARIANT = args.variant || 'sub';
const PER = Number(args.per || 5);
const MINUTES = Number(args.minutes || 5);
const RAMP_S = Number(args.ramp || 20);
const EVERY_S = Number(args.every || 10);
const OUT = args.out || `loadtest-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
const INSECURE = !!args.insecure;
const PASSWORD = process.env.LOOKY_ADMIN_PASSWORD || '';

const ET = { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true };
const clock = (ms = Date.now()) => new Date(ms).toLocaleTimeString('en-US', ET);
const now = () => performance.now();

// Resolve the host to --ip, so .local names work where this machine has no mDNS.
const lookup = args.ip
  ? (host, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (opts && opts.all) cb(null, [{ address: args.ip, family: 4 }]); else cb(null, args.ip, 4);
  }
  : dns.lookup;
const tls = { rejectUnauthorized: !INSECURE, servername: BASE.hostname, lookup };

function getJson(path) {
  const mod = BASE.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const headers = PASSWORD ? { Authorization: 'Basic ' + Buffer.from('admin:' + PASSWORD).toString('base64') } : {};
    const req = mod.get(new URL(path, BASE), { ...tls, headers, timeout: 8000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`${path}: HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${path}: timed out`)));
    req.on('error', reject);
  });
}

const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
const sortNum = (a) => a.sort((x, y) => x - y);
const r0 = (v) => (v == null ? null : Math.round(v));
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/* --- one viewer ------------------------------------------------------------ */

class Viewer {
  constructor(cameraId, n) {
    this.cameraId = cameraId;
    this.n = n;
    this.offset = null;           // performance.now() - server clock (ms)
    this.pings = [];
    this.connects = 0;
    this.closes = {};
    this.resets = 0;
    this.errors = 0;
    this.stopped = false;
    this.lastPts = null;
    this.intervals = [];          // recent frame intervals (µs), for stall detection
    this.win = this._newWindow();
  }

  _newWindow() { return { frames: 0, bytes: 0, lags: [], stalls: 0, maxGapMs: 0 }; }

  start() {
    if (this.stopped) return;
    const url = new URL('/cameras/stream', BASE);
    url.protocol = BASE.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url, { ...tls, perMessageDeflate: false, headers: { 'User-Agent': 'LookyLooky-loadtest/1' } });
    this.ws = ws;
    ws.on('open', () => {
      this.connects++;
      ws.send(JSON.stringify({ action: 'subscribe', cameraId: this.cameraId, quality: VARIANT, audio: 'none', audioEnabled: false }));
      this.ping();
      this.rep = { at: now(), frames: 0, lags: [] };
      this.pinger = setInterval(() => { this.ping(); this.sendReport(); }, 5000);
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        let m;
        try { m = JSON.parse(data.toString()); } catch { return; }
        if (m.type === 'pong' && typeof m.mono === 'number' && typeof m.c === 'number') {
          const rtt = now() - m.c;
          this.pings.push({ rtt, offset: m.c + rtt / 2 - m.mono });
          if (this.pings.length > 6) this.pings.shift();
          this.offset = this.pings.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
        }
        return;
      }
      this.onBinary(data);
    });
    ws.on('close', (code) => {
      clearInterval(this.pinger);
      this.closes[code] = (this.closes[code] || 0) + 1;
      this.lastPts = null;
      if (!this.stopped) setTimeout(() => this.start(), 1000 + Math.random() * 1000);
    });
    ws.on('error', () => { this.errors++; });
  }

  ping() {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ action: 'ping', c: now() }));
  }

  /** The same report a browser pane sends, so the statistics page lists these viewers too (no Screen column). */
  sendReport() {
    const r = this.rep;
    if (!r || !this.ws || this.ws.readyState !== 1) return;
    const lags = sortNum(r.lags);
    const at = (q) => (lags.length ? Math.round(quantile(lags, q)) : null);
    this.ws.send(JSON.stringify({
      action: 'report', fps: r1(r.frames / ((now() - r.at) / 1000)), dropped: 0, decodeQueue: 0, videoQueue: 0,
      arrival: lags.length ? { p50: at(0.5), p95: at(0.95), max: Math.round(lags[lags.length - 1]) } : null, render: null,
      rttMs: this.pings.length ? Math.round(Math.min(...this.pings.map((p) => p.rtt))) : null,
    }));
    this.rep = { at: now(), frames: 0, lags: [] };
  }

  onBinary(buf) {
    if (buf.length < 2 || buf[0] !== 1) return;
    const type = buf[1];
    if (type === 0x06) { this.resets++; this.lastPts = null; return; }
    if (type !== 0x03 || buf.length < 11) return;
    const flags = buf[2];
    const pts = Number(buf.readBigInt64LE(3));
    const w = this.win;
    w.bytes += buf.length;
    if (flags & 0x02) return;     // catch-up replay of the cached GOP
    w.frames++;
    if (this.rep) this.rep.frames++;
    if (this.offset !== null) {
      const lag = now() - this.offset - pts / 1000;
      w.lags.push(lag);
      if (this.rep && this.rep.lags.length < 3000) this.rep.lags.push(lag);
    }
    if (this.lastPts !== null) {
      const gap = pts - this.lastPts;
      if (gap > 0) {
        this.intervals.push(gap);
        if (this.intervals.length > 50) this.intervals.shift();
        const typical = quantile(sortNum([...this.intervals]), 0.5) || gap;
        if (gap > Math.max(3 * typical, 400000)) { w.stalls++; w.maxGapMs = Math.max(w.maxGapMs, gap / 1000); }
      }
    }
    this.lastPts = pts;
  }

  take() { const w = this.win; this.win = this._newWindow(); return w; }

  stop() { this.stopped = true; clearInterval(this.pinger); try { this.ws.close(); } catch { /* gone */ } }
}

/* --- run ------------------------------------------------------------------- */

function cpuNow() {
  const c = os.cpus().reduce((a, x) => { const t = x.times; return { busy: a.busy + t.user + t.nice + t.sys + t.irq, total: a.total + t.user + t.nice + t.sys + t.irq + t.idle }; }, { busy: 0, total: 0 });
  return c;
}

(async () => {
  let cams;
  try {
    const list = (await getJson('/api/cameras')).cameras;
    const want = args.cameras ? String(args.cameras).split(',') : null;
    cams = list.filter((c) => (want ? want.includes(c.id) : c.enabled !== false && c.status !== 'stopped'))
      .filter((c) => (c.variants || []).some((v) => v.label === VARIANT) || !c.variants);
  } catch (err) {
    console.error(`Can't read the camera list from ${BASE.origin}: ${err.message}`);
    process.exit(1);
  }
  const names = Object.fromEntries(cams.map((c) => [c.id, c.name]));
  console.log(`${clock()}  ${cams.length} cameras × ${PER} viewers on "${VARIANT}" = ${cams.length * PER} viewers, ${MINUTES} min, against ${BASE.origin}${args.ip ? ' (' + args.ip + ')' : ''}`);

  const viewers = [];
  for (let n = 0; n < PER; n++) for (const c of cams) viewers.push(new Viewer(c.id, n));
  viewers.forEach((v, i) => setTimeout(() => v.start(), (i / viewers.length) * RAMP_S * 1000));

  const windows = [];
  const streamTotals = {};
  let cpuPrev = cpuNow();
  const started = Date.now();
  const header = 'time         viewers  fps/viewer  Mbit/s  lag p50/p95/max ms  worst p95  stalls  closes | host CPU  app CPU  ffmpeg CPU  loop p99  server out Mbit/s  my CPU';
  console.log(header);

  const report = async () => {
    let stats = null;
    try { stats = await getJson('/api/stats'); } catch (err) { /* printed as blanks */ }
    const ptsLag = {};
    for (const s of (stats && stats.sessions) || []) if (s.variant === VARIANT) ptsLag[s.cameraId] = s.ptsLagMs || 0;
    const all = [];
    let frames = 0, bytes = 0, stalls = 0, connected = 0, worst = { p95: 0 };
    for (const v of viewers) {
      const w = v.take();
      if (v.ws && v.ws.readyState === 1) connected++;
      frames += w.frames; bytes += w.bytes; stalls += w.stalls;
      const lags = sortNum(w.lags.map((x) => x - (ptsLag[v.cameraId] || 0)));
      for (const x of lags) all.push(x);
      const p95 = quantile(lags, 0.95);
      if (p95 !== null && p95 > worst.p95) worst = { p95, cameraId: v.cameraId, n: v.n };
      const st = streamTotals[v.cameraId] || (streamTotals[v.cameraId] = { frames: 0, lags: [], stalls: 0, maxGapMs: 0 });
      st.frames += w.frames; st.stalls += w.stalls; st.maxGapMs = Math.max(st.maxGapMs, w.maxGapMs);
      if (lags.length) st.lags.push(quantile(lags, 0.5));
    }
    sortNum(all);
    const cpu = cpuNow();
    const myCpu = (1 - (cpu.total - cpu.busy - (cpuPrev.total - cpuPrev.busy)) / Math.max(1, cpu.total - cpuPrev.total)) * 100;
    cpuPrev = cpu;
    const h = stats && stats.host;
    const tx = h ? Object.values(h.net || {}).reduce((a, n) => a + n.txMbps, 0) : null;
    const closes = viewers.reduce((a, v) => a + Object.values(v.closes).reduce((x, y) => x + y, 0), 0);
    const row = {
      at: Date.now(), minute: (Date.now() - started) / 60000, connected, viewers: viewers.length,
      fpsPerViewer: r1(frames / EVERY_S / Math.max(1, connected)), mbps: r1((bytes * 8) / EVERY_S / 1e6),
      lag: { p50: r0(quantile(all, 0.5)), p95: r0(quantile(all, 0.95)), max: r0(all[all.length - 1]) },
      worst: { p95: r0(worst.p95), camera: worst.cameraId || null }, stalls, closes,
      server: h ? { hostCpuPct: h.hostCpuPct, cores: h.cores, appCpuPct: h.app.cpuPct, ffmpegCpuPct: h.ffmpeg.cpuPct, loopP99Ms: h.app.loop.p99Ms, txMbps: r1(tx), memAvailable: h.memAvailable } : null,
      clientCpuPct: r1(myCpu),
    };
    windows.push(row);
    const s = row.server || {};
    const pad = (v, n) => String(v ?? '–').padStart(n);
    console.log(`${clock().padEnd(12)} ${pad(`${connected}/${viewers.length}`, 7)}  ${pad(row.fpsPerViewer, 10)}  ${pad(row.mbps, 6)}  ${pad(`${row.lag.p50}/${row.lag.p95}/${row.lag.max}`, 18)}  ${pad(row.worst.p95, 9)}  ${pad(stalls, 6)}  ${pad(closes, 6)} | ${pad(s.hostCpuPct != null ? s.hostCpuPct + '%' : null, 8)}  ${pad(s.appCpuPct != null ? s.appCpuPct + '%' : null, 7)}  ${pad(s.ffmpegCpuPct != null ? s.ffmpegCpuPct + '%' : null, 10)}  ${pad(s.loopP99Ms != null ? s.loopP99Ms + ' ms' : null, 8)}  ${pad(s.txMbps, 17)}  ${pad(row.clientCpuPct + '%', 6)}`);
  };

  const tick = setInterval(report, EVERY_S * 1000);
  await new Promise((r) => setTimeout(r, MINUTES * 60000));
  clearInterval(tick);
  await report();
  viewers.forEach((v) => v.stop());

  // Lag trend after the ramp: least-squares slope of the p95 per minute.
  const steady = windows.filter((w) => w.minute * 60 > RAMP_S + EVERY_S && w.lag.p95 != null);
  let slope = null;
  if (steady.length >= 3) {
    const mx = steady.reduce((a, w) => a + w.minute, 0) / steady.length;
    const my = steady.reduce((a, w) => a + w.lag.p95, 0) / steady.length;
    const num = steady.reduce((a, w) => a + (w.minute - mx) * (w.lag.p95 - my), 0);
    const den = steady.reduce((a, w) => a + (w.minute - mx) ** 2, 0);
    slope = den ? num / den : null;
  }
  const streams = Object.entries(streamTotals).map(([id, s]) => ({
    cameraId: id, name: names[id], fpsPerViewer: r1(s.frames / PER / ((Date.now() - started) / 1000)),
    lagP50: r0(quantile(sortNum(s.lags), 0.5)), lagWorst: r0(Math.max(...s.lags, 0)), stalls: s.stalls, maxGapMs: r0(s.maxGapMs),
  })).sort((a, b) => (b.lagWorst - a.lagWorst) || (b.stalls - a.stalls));
  const peak = (f) => Math.max(...windows.map(f).filter((x) => x != null), 0);
  const summary = {
    finishedAt: new Date().toISOString(), url: BASE.origin, variant: VARIANT, per: PER, cameras: cams.length, viewers: viewers.length, minutes: MINUTES,
    lagTrendMsPerMin: r1(slope),
    steady: steady.length ? {
      lagP50: r0(quantile(sortNum(steady.map((w) => w.lag.p50)), 0.5)), lagP95: r0(quantile(sortNum(steady.map((w) => w.lag.p95)), 0.5)),
      fpsPerViewer: r1(quantile(sortNum(steady.map((w) => w.fpsPerViewer)), 0.5)), mbps: r1(quantile(sortNum(steady.map((w) => w.mbps)), 0.5)),
    } : null,
    peaks: {
      hostCpuPct: peak((w) => w.server && w.server.hostCpuPct), appCpuPct: peak((w) => w.server && w.server.appCpuPct),
      ffmpegCpuPct: peak((w) => w.server && w.server.ffmpegCpuPct), loopP99Ms: peak((w) => w.server && w.server.loopP99Ms),
      serverTxMbps: peak((w) => w.server && w.server.txMbps), clientCpuPct: peak((w) => w.clientCpuPct),
    },
    stalls: windows.reduce((a, w) => a + w.stalls, 0),
    closes: viewers.reduce((a, v) => { for (const [k, n] of Object.entries(v.closes)) a[k] = (a[k] || 0) + n; return a; }, {}),
    resets: viewers.reduce((a, v) => a + v.resets, 0),
    streams, windows,
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(`\nSteady state: lag p50 ${summary.steady?.lagP50} ms, p95 ${summary.steady?.lagP95} ms; ${summary.steady?.fpsPerViewer} fps per viewer; ${summary.steady?.mbps} Mbit/s received`);
  console.log(`Lag trend: ${slope == null ? 'not enough data' : `${r1(slope)} ms per minute (p95)`}; stalls ${summary.stalls}; closes ${JSON.stringify(summary.closes)}; stream resets ${summary.resets}`);
  console.log(`Server peaks: host CPU ${summary.peaks.hostCpuPct}% (all cores), LookyLooky ${summary.peaks.appCpuPct}% and FFmpeg ${summary.peaks.ffmpegCpuPct}% of one core, loop delay p99 ${summary.peaks.loopP99Ms} ms, out ${summary.peaks.serverTxMbps} Mbit/s`);
  console.log('Worst streams:');
  for (const s of streams.slice(0, 6)) console.log(`  ${(s.name || s.cameraId).padEnd(24)} ${s.fpsPerViewer} fps  lag p50 ${s.lagP50} ms, worst ${s.lagWorst} ms  stalls ${s.stalls}${s.maxGapMs ? ` (longest gap ${s.maxGapMs} ms)` : ''}`);
  console.log(`Results: ${OUT}`);
  process.exit(0);
})();
