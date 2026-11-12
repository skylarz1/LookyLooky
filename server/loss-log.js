'use strict';
/**
 * Packet loss per stream and minute, for the statistics page.
 *
 * The loss counters in /api/stats start again with every restart, and loss
 * on a camera network comes and goes with the time of day.  So once a
 * minute, what each stream lost since the last look (RTP gaps), the freezes
 * and frames held back after it (stream-session.js _onRtpLoss) and the
 * frames that went out are written down.  24 hours are kept, and saved to
 * DATA_DIR/loss-history.json every 5 minutes and on shutdown, so a restart
 * or a deploy doesn't empty the chart.
 *
 * A row: { t: <end of the minute, ms>, s: { "<camera>/<stream>": [gaps, held, frames, freezes] } }
 * with only the streams that lost something; a minute without loss is a row
 * with an empty `s`, a minute the server was not running has no row.
 */

const MINUTE_MS = 60000;
const KEEP_MS = 24 * 3600 * 1000;
const SAVE_EVERY = 5;           // minutes
const FILE = 'loss-history.json';
const FIELDS = ['rtpGaps', 'lossHeld', 'frames', 'lossHolds'];

class LossLog {
  /** `read(file, fallback)` and `write(file, data)` as config.js has them; `now` and `timer` for tests. */
  constructor(manager, { read, write, now = Date.now, timer = true } = {}) {
    this.manager = manager;
    this.write = write;
    this.now = now;
    this.prev = new Map();        // "id/label" -> the counters at the last look
    this.unsaved = 0;
    const saved = read ? read(FILE, null) : null;
    const from = now() - KEEP_MS;
    this.rows = saved && Array.isArray(saved.rows) ? saved.rows.filter((r) => r && r.t > from && r.s && typeof r.s === 'object') : [];
    if (timer) {
      this.timer = setInterval(() => this.sample(), MINUTE_MS);
      this.timer.unref();
    }
  }

  sample() {
    const t = this.now();
    const s = {};
    const seen = new Set();
    for (const sess of this.manager.sessions.values()) {
      const key = `${sess.cameraId}/${sess.label}`;
      seen.add(key);
      const cur = FIELDS.map((f) => sess.stats[f] || 0);
      const before = this.prev.get(key);
      this.prev.set(key, cur);
      // A session made anew (camera edited) counts from zero again.
      const d = cur.map((v, i) => (before && v >= before[i] ? v - before[i] : v));
      if (d[0] || d[1]) s[key] = d;
    }
    for (const key of [...this.prev.keys()]) if (!seen.has(key)) this.prev.delete(key);
    this.rows.push({ t, s });
    while (this.rows.length && this.rows[0].t <= t - KEEP_MS) this.rows.shift();
    if (++this.unsaved >= SAVE_EVERY) this.save();
  }

  save() {
    this.unsaved = 0;
    if (!this.write) return;
    try { this.write(FILE, { rows: this.rows }); } catch (err) { console.error(`[loss-log] not saved: ${err.message}`); }
  }
}

module.exports = { LossLog, MINUTE_MS };
