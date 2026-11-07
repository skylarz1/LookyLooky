'use strict';
/**
 * Stream test: what is at this URL, and if nothing, why not.
 * Used before a camera is saved (422 STREAM_TEST_FAILED), by the batch add,
 * and in the background to fill in each variant's codec / resolution.
 */

const { spawn } = require('child_process');
const { inputArgs, friendlyError, wantsMulticast, multicastState, noteMulticast } = require('./sources');

function fpsOf(r) {
  const [n, d] = String(r || '').split('/').map(Number);
  return n && d ? Math.round((n / d) * 100) / 100 : null;
}

async function probe(source, settings, opts = {}) {
  // Multicast first when it's wanted (and hasn't just failed for this stream),
  // with a short timeout: when it doesn't reach us, nothing arrives at all.
  if (wantsMulticast(source, settings) && multicastState(opts.key) !== 'failed') {
    const m = await probeOnce(source, settings, { ...opts, multicast: true, timeoutMs: Math.min(opts.timeoutMs || 15000, 8000) });
    if (m.ok) { noteMulticast(opts.key, true); return { ...m, multicast: true }; }
    const u = await probeUnicast(source, settings, opts);
    if (u.ok) {
      noteMulticast(opts.key, false);
      return { ...u, note: [u.note, 'Multicast did not reach LookyLooky; it will play over unicast'].filter(Boolean).join('. ') };
    }
    return u;
  }
  return probeUnicast(source, settings, opts);
}

async function probeUnicast(source, settings, opts = {}) {
  const r = await probeOnce(source, settings, { ...opts, multicast: false });
  // UDP that fails here (Docker's bridged network blocks the return path) but
  // works over TCP is reported as playable — the stream falls back the same way.
  if (!r.ok && source.type === 'rtsp' && source.transport === 'udp') {
    const t = await probeOnce(source, settings, { ...opts, forceTcp: true });
    if (t.ok) return { ...t, note: 'UDP did not work from here; it will play over TCP' };
  }
  return r;
}

async function probeOnce(source, settings, { timeoutMs = 15000, key, forceTcp = false, multicast } = {}) {
  if (source.type === 'test' || /^(test|lavfi):/i.test(source.url)) {
    const m = /(\d+)x(\d+)(?:@(\d+))?/.exec(source.url) || [];
    return { ok: true, videoCodec: 'h264', width: Number(m[1] || 1280), height: Number(m[2] || 720), fps: Number(m[3] || 25), audioCodec: 'pcm', hasAudio: true };
  }
  let input;
  try { input = await inputArgs(source, settings, { key, lowLatency: false, forceTcp, multicast }); }
  catch (err) { return { ok: false, error: err.message }; }
  const args = [];
  for (let i = 0; i < input.args.length; i++) {
    const a = input.args[i];
    if (a === '-re') continue;
    if (a === '-stream_loop') { i++; continue; }
    args.push(a);
  }
  return new Promise((resolve) => {
    const proc = spawn(settings.ffmpeg.probePath || 'ffprobe',
      ['-v', 'error', '-of', 'json', '-show_streams', '-probesize', '2000000', '-analyzeduration', '3000000', ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { err += '\nConnection timed out'; proc.kill('SIGKILL'); }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    proc.on('error', (e) => { err += `\nspawn ${e.code} ENOENT`; });
    proc.on('close', (code) => {
      clearTimeout(timer);
      let streams = [];
      try { streams = JSON.parse(out).streams || []; } catch { /* no json */ }
      const v = streams.find((s) => s.codec_type === 'video');
      const a = streams.find((s) => s.codec_type === 'audio');
      if (!v) {
        const why = friendlyError(err) || (code === 0 ? 'The stream has no video' : (err.trim().split('\n').pop() || `ffprobe failed (${code})`));
        resolve({ ok: false, error: why });
        return;
      }
      resolve({
        ok: true,
        videoCodec: v.codec_name, width: v.width, height: v.height,
        fps: fpsOf(v.avg_frame_rate) || fpsOf(v.r_frame_rate),
        audioCodec: a ? a.codec_name : null, hasAudio: !!a,
      });
    });
  });
}

/**
 * What a camera's RTSP server answers to a multicast SETUP, from FFmpeg's
 * trace of the server's reply lines: the group and port it will send to, or
 * why it won't.
 * @returns {{ok: boolean, address?: string, port?: number|null, error?: string}}
 */
function parseMulticastReply(text) {
  const transport = (/Transport:([^'\n]*)/i.exec(text) || [])[1];
  if (transport) {
    const p = {};
    for (const kv of transport.split(';')) {
      const i = kv.indexOf('=');
      if (i > 0) p[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim();
    }
    if (!/multicast/i.test(transport)) return { ok: false, error: 'The camera answered with unicast instead' };
    const address = p.destination || '';
    if (!address || address === '0.0.0.0') return { ok: false, error: 'The camera accepts multicast but has no multicast address set' };
    return { ok: true, address, port: parseInt(p.port, 10) || null };
  }
  // 401 is the normal first answer before the credentials are sent.
  const status = /RTSP\/1\.0 ((?!401)[45]\d\d)([^'\n]*)/.exec(text);
  if (status && status[1] === '404') return { ok: false, error: 'The camera has no multicast stream at that address (404)' };
  if (status && status[1] === '461') return { ok: false, error: 'The camera does not offer multicast (461) — switched off on it?' };
  if (status) return { ok: false, error: `The camera refused multicast (${status[1]}${status[2].replace(/'.*/, '')})` };
  // UniFi Protect, for one, drops the connection instead of answering.
  if (/Invalid data found/i.test(text)) return { ok: false, error: 'The camera did not accept the multicast request (no valid answer to it)' };
  // Without the challenge 401s, an "Unauthorized" left is FFmpeg giving up on the password.
  const rest = text.split('\n').filter((l) => !/line='RTSP\/1\.0 401/.test(l)).join('\n');
  return { ok: false, error: friendlyError(rest) || 'The camera did not answer the multicast request' };
}

/**
 * Ask the camera for a stream as multicast and report its answer (above).
 * ONVIF's multicast settings can't be relied on for this: Dahua cameras
 * report one group there and send to another (their web page's, by default
 * 224.1.2.4 on every camera).  Nothing is received; FFmpeg is stopped as soon
 * as the answer is in.
 */
function multicastSetup(source, settings, { timeoutMs = 8000 } = {}) {
  const url = source.multicastUrl || source.url;
  return new Promise((resolve) => {
    const proc = spawn(settings.ffmpeg.path || 'ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'trace',
      '-rtsp_transport', 'udp_multicast', '-timeout', '5000000', '-i', url, '-t', '0.1', '-f', 'null', '-'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
    // Only the server's replies and FFmpeg's errors are kept: the trace also
    // echoes our own requests, credentials included.
    let text = '', partial = '';
    const timer = setTimeout(() => { text += 'Connection timed out\n'; proc.kill('SIGKILL'); }, timeoutMs);
    proc.stderr.on('data', (d) => {
      const lines = (partial + d).split('\n');
      partial = lines.pop();
      for (const line of lines) {
        if (/line='(RTSP\/1\.0|Transport:)/.test(line) || /refused|unreachable|No route|timed out|Unauthorized|Invalid data found/i.test(line)) text += line + '\n';
        if (/line='Transport:/.test(line) || /line='RTSP\/1\.0 (?!401)[45]\d\d/.test(line)) proc.kill('SIGKILL');
      }
    });
    proc.on('error', (e) => { text += `spawn ${e.code} ENOENT\n`; });
    proc.on('close', () => { clearTimeout(timer); resolve(parseMulticastReply(text)); });
  });
}

module.exports = { probe, multicastSetup, parseMulticastReply };
