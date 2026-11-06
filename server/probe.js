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

module.exports = { probe };
