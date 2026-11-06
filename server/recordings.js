'use strict';
/**
 * Ad-hoc recordings: one at a time (409 on a second start), written straight
 * from the camera with the video copied, audio as AAC so the file plays in
 * every browser (Safari included) and in anything else.  A recording ends at
 * Stop, at recordings.maxDurationMs, or when the camera stream ends.  Files
 * older than recordings.retentionDays are deleted hourly.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { inputArgs, friendlyError, redact, multicastState } = require('./sources');

const safe = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'x';
const stamp = (d) => d.toISOString().replace(/\..*$/, '').replace('T', '_').replace(/:/g, '-');

class Recorder {
  constructor(manager) {
    this.manager = manager;
    this.active = null;
    this.lastError = null;
    this.sweep = setInterval(() => this.applyRetention(), 3600000);
    this.sweep.unref();
    setTimeout(() => this.applyRetention(), 10000).unref();
  }

  get store() { return this.manager.store; }
  dir() { return this.store.recordingsDir(); }

  activeInfo() {
    if (!this.active) return null;
    const { id, cameraId, variant, startedAt, filename, layoutName } = this.active;
    return { id, cameraId, variant, startedAt, filename, layoutName };
  }

  async start({ cameraId, variant, layoutName }) {
    if (this.active) throw Object.assign(new Error(`Already recording ${this.active.cameraId} — stop that first`), { status: 409 });
    const cam = this.manager.camera(cameraId);
    if (!cam) throw Object.assign(new Error(`No camera '${cameraId}'`), { status: 404 });
    const label = this.manager.resolveLabel(cam, variant);
    const src = cam.sources.find((s) => s.label === label);
    const settings = this.store.settings;
    const key = `${cam.id}/${label}`;
    // A recording has no fallback of its own, so it joins multicast only
    // when that stream is known to be getting a picture over it.
    const input = await inputArgs(src, settings, { key, lowLatency: false, multicast: multicastState(key) === 'ok' ? undefined : false });
    const info = this.manager.variantInfo(cam.id, label) || {};
    const encode = src.transcode || input.needsEncode || (info.videoCodec && !['h264', 'hevc'].includes(info.videoCodec));
    const started = new Date();
    const filename = `${safe(layoutName || 'recording')}_${safe(cam.name)}_${label}_${stamp(started)}.mp4`;
    const partial = path.join(this.dir(), `.${filename}.part`);
    const maxSec = Math.max(10, Math.round((settings.recordings.maxDurationMs || 7200000) / 1000));
    const args = ['-hide_banner', '-loglevel', 'warning', ...input.args,
      '-map', input.video, '-map', input.audio + '?',
      ...(encode ? ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'] : ['-c:v', 'copy']),
      ...(info.videoCodec === 'hevc' && !encode ? ['-tag:v', 'hvc1'] : []),
      '-c:a', 'aac', '-b:a', '128k', '-t', String(maxSec), '-movflags', '+faststart', '-f', 'mp4', '-y', partial];
    console.log(`[recordings] start ${cam.id}/${label} ${redact(src.url)} -> ${filename}`);
    const proc = spawn(settings.ffmpeg.path || 'ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.manager.protectedPids.add(proc.pid);
    let tail = '';
    proc.stderr.on('data', (d) => { tail = (tail + d).slice(-3000); });
    proc.stdin.on('error', () => {});
    const rec = { id: `rec-${started.getTime()}`, cameraId: cam.id, variant: label, startedAt: started.getTime(), filename, layoutName: layoutName || '', proc, partial };
    this.active = rec;
    proc.on('close', (code) => {
      this.manager.protectedPids.delete(proc.pid);
      if (this.active === rec) this.active = null;
      let size = 0;
      try { size = fs.statSync(partial).size; } catch { /* nothing written */ }
      if (size > 0) {
        fs.renameSync(partial, path.join(this.dir(), filename));
        console.log(`[recordings] saved ${filename} (${size} bytes)`);
      } else {
        try { fs.unlinkSync(partial); } catch { /* none */ }
        this.lastError = friendlyError(tail) || tail.trim().split('\n').pop() || `ffmpeg exited ${code}`;
        console.log(`[recordings] failed: ${this.lastError}`);
      }
      if (rec._resolveStop) rec._resolveStop();
    });
    // Fail fast when the camera cannot be opened at all.
    await new Promise((r) => setTimeout(r, 300));
    if (proc.exitCode !== null && this.active !== rec) {
      throw Object.assign(new Error(`Recording failed: ${this.lastError || 'FFmpeg exited'}`), { status: 502 });
    }
    return this.activeInfo();
  }

  stop() {
    const rec = this.active;
    if (!rec) return Promise.resolve(null);
    return new Promise((resolve) => {
      rec._resolveStop = () => resolve(rec.filename);
      try { rec.proc.stdin.write('q'); } catch { /* ignore */ }
      setTimeout(() => { try { rec.proc.kill('SIGINT'); } catch { /* gone */ } }, 4000).unref();
      setTimeout(() => { try { rec.proc.kill('SIGKILL'); } catch { /* gone */ } }, 12000).unref();
    });
  }

  list() {
    let names = [];
    try { names = fs.readdirSync(this.dir()); } catch { return []; }
    return names
      .filter((n) => !n.startsWith('.') && /\.(mp4|mkv|mov)$/i.test(n))
      .map((n) => {
        try { const st = fs.statSync(path.join(this.dir(), n)); return { filename: n, sizeBytes: st.size, mtime: st.mtimeMs }; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
  }

  /** Absolute path of a recording, or null — never anything outside the directory. */
  resolve(name) {
    const base = path.basename(String(name || ''));
    if (!base || base.startsWith('.') || base !== name) return null;
    const p = path.join(this.dir(), base);
    return fs.existsSync(p) ? p : null;
  }

  remove(name) {
    const p = this.resolve(name);
    if (!p) throw Object.assign(new Error('No such recording'), { status: 404 });
    fs.unlinkSync(p);
  }

  applyRetention() {
    const days = Number(this.store.settings.recordings.retentionDays);
    if (!(days > 0)) return;
    const cutoff = Date.now() - days * 86400000;
    for (const f of this.list()) {
      if (f.mtime < cutoff) {
        try { fs.unlinkSync(path.join(this.dir(), f.filename)); console.log(`[recordings] retention: deleted ${f.filename}`); }
        catch { /* ignore */ }
      }
    }
  }

  shutdown() {
    if (this.active) try { this.active.proc.stdin.write('q'); } catch { /* ignore */ }
    clearInterval(this.sweep);
  }
}

module.exports = { Recorder };
