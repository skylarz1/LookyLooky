'use strict';
/**
 * Host and process load for /api/stats and the statistics page.
 *
 * Sampled every 2 s: this process's CPU and event-loop delay (the delay is
 * what turns into frame lag here: every frame of every viewer goes through
 * this one loop), each FFmpeg's CPU and memory, the host's CPU, memory and
 * network interfaces.  The last 30 minutes are kept for the page's charts.
 *
 * The per-PID and host figures read /proc, so they exist on Linux only; on
 * other hosts those fields stay null.
 */

const fs = require('fs');
const os = require('os');
const { monitorEventLoopDelay } = require('perf_hooks');

const SAMPLE_MS = 2000;
const HISTORY = 900;            // 30 min of 2 s samples
const TICK_HZ = 100;            // USER_HZ: /proc CPU times are in 1/100 s on Linux
const LOOP_RES_MS = 10;

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

function pidTimes(pid) {
  const stat = read(`/proc/${pid}/stat`);
  if (!stat) return null;
  const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const status = read(`/proc/${pid}/status`);
  const rss = status && /VmRSS:\s+(\d+) kB/.exec(status);
  return { cpu: (Number(f[11]) + Number(f[12])) / TICK_HZ, rss: rss ? Number(rss[1]) * 1024 : null };
}

function hostCpu() {
  const line = (read('/proc/stat') || '').split('\n')[0];
  if (!line.startsWith('cpu ')) return null;
  const n = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = n[3] + (n[4] || 0);
  return { total: n.reduce((a, b) => a + b, 0), idle };
}

function netDev() {
  const text = read('/proc/net/dev');
  if (!text) return null;
  const out = {};
  for (const line of text.split('\n').slice(2)) {
    const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!m || m[1] === 'lo' || /^(veth|docker|br-)/.test(m[1])) continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    out[m[1]] = { rx: v[0], tx: v[8] };
  }
  return out;
}

const pct = (v) => (v === null ? null : Math.round(v * 10) / 10);

class Metrics {
  constructor(manager, hub) {
    this.manager = manager;
    this.hub = hub;
    this.loop = monitorEventLoopDelay({ resolution: LOOP_RES_MS });
    this.loop.enable();
    this.history = [];
    this.pidCpu = new Map();      // pid -> CPU % of one core over the last sample
    this.pidRss = new Map();
    this.latest = null;
    this._prev = null;
    this._sample();
    this.timer = setInterval(() => this._sample(), SAMPLE_MS);
    this.timer.unref();
  }

  _sample() {
    const now = Date.now();
    const cpu = process.cpuUsage();
    const host = hostCpu();
    const net = netDev();
    const pids = new Map();
    for (const p of this.manager.processes) {
      const t = p.pid && pidTimes(p.pid);
      if (t) pids.set(p.pid, t);
    }
    const prev = this._prev;
    this._prev = { at: now, cpu, host, net, pids };
    if (!prev) return;
    const dt = (now - prev.at) / 1000;

    this.pidCpu.clear();
    this.pidRss.clear();
    let ffCpu = 0, ffRss = 0, ffCount = 0;
    for (const [pid, t] of pids) {
      const before = prev.pids.get(pid);
      const c = before ? ((t.cpu - before.cpu) / dt) * 100 : null;
      if (c !== null) { this.pidCpu.set(pid, pct(c)); ffCpu += c; }
      if (t.rss) { this.pidRss.set(pid, t.rss); ffRss += t.rss; }
      ffCount++;
    }
    const appCpu = ((cpu.user - prev.cpu.user + cpu.system - prev.cpu.system) / 1e6 / dt) * 100;
    let hostPct = null;
    if (host && prev.host) {
      const total = host.total - prev.host.total;
      hostPct = total > 0 ? (1 - (host.idle - prev.host.idle) / total) * 100 : null;
    }
    const nets = {};
    if (net && prev.net) {
      for (const [name, v] of Object.entries(net)) {
        const b = prev.net[name];
        if (!b) continue;
        nets[name] = { rxMbps: Math.round(((v.rx - b.rx) * 8) / dt / 1e4) / 100, txMbps: Math.round(((v.tx - b.tx) * 8) / dt / 1e4) / 100 };
      }
    }
    const loop = {
      // The histogram counts the timer's own resolution; take it off.
      p50Ms: Math.max(0, Math.round(this.loop.percentile(50) / 1e4) / 100 - LOOP_RES_MS),
      p99Ms: Math.max(0, Math.round(this.loop.percentile(99) / 1e4) / 100 - LOOP_RES_MS),
      maxMs: Math.max(0, Math.round(this.loop.max / 1e4) / 100 - LOOP_RES_MS),
    };
    this.loop.reset();

    let viewers = 0, watching = 0, streams = 0;
    for (const v of this.hub.viewers) { viewers++; if (v.session) watching++; }
    for (const s of this.manager.sessions.values()) if (s.state === 'live') streams++;
    const mem = process.memoryUsage();

    this.latest = {
      at: now,
      cores: os.cpus().length,
      loadavg: os.loadavg().map((x) => Math.round(x * 100) / 100),
      hostCpuPct: pct(hostPct),
      memTotal: os.totalmem(),
      memAvailable: memAvailable(),
      app: { cpuPct: pct(appCpu), rss: mem.rss, heapUsed: mem.heapUsed, loop },
      ffmpeg: { count: ffCount, cpuPct: pids.size ? pct(ffCpu) : null, rss: ffRss || null },
      net: nets,
      viewers, watching, streams,
    };
    this.history.push({
      t: now, host: pct(hostPct), app: pct(appCpu), ff: pids.size ? pct(ffCpu) : null,
      loop: loop.p99Ms, viewers: watching, streams,
      rx: Object.values(nets).reduce((a, n) => a + n.rxMbps, 0), tx: Object.values(nets).reduce((a, n) => a + n.txMbps, 0),
    });
    if (this.history.length > HISTORY) this.history.shift();
  }
}

function memAvailable() {
  const m = /MemAvailable:\s+(\d+) kB/.exec(read('/proc/meminfo') || '');
  return m ? Number(m[1]) * 1024 : os.freemem();
}

module.exports = { Metrics };
