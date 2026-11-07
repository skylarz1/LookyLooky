'use strict';
/**
 * Streaming fragmented-MP4 parser.
 *
 * FFmpeg writes each camera variant as fragmented MP4 (`empty_moov +
 * default_base_moof + frag_every_frame`) to a pipe.  This splits that byte
 * stream into top-level boxes and turns it into:
 *
 *   'init'     { tracks: Map<trackId, Track>, raw: Buffer }   — ftyp + moov
 *   'fragment' { raw: Buffer, samples: Sample[], hasKey }      — moof + mdat
 *
 * A Track carries what the browser needs to configure a decoder: for video
 * the avcC / hvcC record (which IS the WebCodecs `description`) and the RFC
 * 6381 codec string; for Opus the channel count, rate and pre-skip from dOps.
 *
 * Samples come out with presentation timestamps in microseconds and their
 * payload as a slice of the fragment — for video that payload is already
 * AVCC (length-prefixed NAL units), exactly what EncodedVideoChunk wants.
 */

const { EventEmitter } = require('events');

const MAX_BOX = 64 * 1024 * 1024;

function readBoxes(buf, start, end) {
  const out = [];
  let i = start;
  while (i + 8 <= end) {
    let size = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(i + 8)); hdr = 16; }
    else if (size === 0) size = end - i;
    if (size < hdr || i + size > end) break;
    out.push({ type, start: i, end: i + size, body: i + hdr });
    i += size;
  }
  return out;
}

const child = (buf, box, type) => readBoxes(buf, box.body, box.end).find((b) => b.type === type);
const hex2 = (n) => n.toString(16).padStart(2, '0');

function avcCodecString(avcC) {
  return `avc1.${hex2(avcC[1])}${hex2(avcC[2])}${hex2(avcC[3])}`.toUpperCase().replace('AVC1', 'avc1');
}

function hevcCodecString(hvcC) {
  const b1 = hvcC[1];
  const space = ['', 'A', 'B', 'C'][b1 >> 6];
  const tier = (b1 >> 5) & 1 ? 'H' : 'L';
  const profile = b1 & 0x1f;
  let compat = hvcC.readUInt32BE(2);
  let rev = 0;
  for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
  const level = hvcC[12];
  const cons = [];
  for (let i = 6; i < 12; i++) cons.push(hvcC[i]);
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  let s = `hvc1.${space}${profile}.${(rev >>> 0).toString(16).toUpperCase()}.${tier}${level}`;
  if (cons.length) s += '.' + cons.map((c) => c.toString(16).toUpperCase()).join('.');
  return s;
}

function parseMoov(buf, moov) {
  const tracks = new Map();
  const trex = new Map();
  const mvex = child(buf, moov, 'mvex');
  if (mvex) {
    for (const t of readBoxes(buf, mvex.body, mvex.end)) {
      if (t.type !== 'trex') continue;
      const p = t.body + 4;
      trex.set(buf.readUInt32BE(p), {
        duration: buf.readUInt32BE(p + 8),
        size: buf.readUInt32BE(p + 12),
        flags: buf.readUInt32BE(p + 16),
      });
    }
  }
  for (const trak of readBoxes(buf, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue;
    const tkhd = child(buf, trak, 'tkhd');
    const mdia = child(buf, trak, 'mdia');
    if (!tkhd || !mdia) continue;
    const tkVer = buf[tkhd.body];
    const id = buf.readUInt32BE(tkhd.body + 4 + (tkVer === 1 ? 16 : 8));
    const mdhd = child(buf, mdia, 'mdhd');
    const hdlr = child(buf, mdia, 'hdlr');
    const mdVer = buf[mdhd.body];
    const timescale = buf.readUInt32BE(mdhd.body + 4 + (mdVer === 1 ? 16 : 8));
    const handler = buf.toString('latin1', hdlr.body + 8, hdlr.body + 12);
    const minf = child(buf, mdia, 'minf');
    const stbl = minf && child(buf, minf, 'stbl');
    const stsd = stbl && child(buf, stbl, 'stsd');
    if (!stsd) continue;
    const entry = readBoxes(buf, stsd.body + 8, stsd.end)[0];
    if (!entry) continue;

    const track = { id, timescale, handler, format: entry.type, defaults: trex.get(id) || {} };
    if (handler === 'vide') {
      track.kind = 'video';
      track.width = buf.readUInt16BE(entry.body + 24);
      track.height = buf.readUInt16BE(entry.body + 26);
      const kids = readBoxes(buf, entry.body + 78, entry.end);
      const avcC = kids.find((k) => k.type === 'avcC');
      const hvcC = kids.find((k) => k.type === 'hvcC');
      if (avcC) {
        track.record = Buffer.from(buf.subarray(avcC.body, avcC.end));
        track.fourCC = 'avc1';
        track.codec = 'h264';
        track.codecString = avcCodecString(track.record);
      } else if (hvcC) {
        track.record = Buffer.from(buf.subarray(hvcC.body, hvcC.end));
        track.fourCC = 'hvc1';
        track.codec = 'hevc';
        // An hvcC without its VPS (or an empty one) can't configure a decoder;
        // the pipeline completes it from the stream's in-band parameter sets.
        track.complete = hvccComplete(track.record);
        track.codecString = track.record.length >= 23 ? hevcCodecString(track.record) : null;
      } else {
        track.codec = entry.type;
      }
    } else if (handler === 'soun') {
      track.kind = 'audio';
      track.channels = buf.readUInt16BE(entry.body + 16);
      track.sampleRate = buf.readUInt32BE(entry.body + 24) >>> 16;
      const kids = readBoxes(buf, entry.body + 28, entry.end);
      const dOps = kids.find((k) => k.type === 'dOps');
      if (entry.type === 'Opus' && dOps) {
        track.codec = 'opus';
        track.channels = buf[dOps.body + 1];
        track.preSkip = buf.readUInt16BE(dOps.body + 2);
        track.sampleRate = 48000; // Opus always decodes at 48 kHz
      } else {
        track.codec = entry.type === 'mp4a' ? 'aac' : entry.type;
      }
    }
    tracks.set(id, track);
  }
  return tracks;
}

/* --- HEVC parameter sets ----------------------------------------------------
 * Some cameras (Uniview) leave the VPS out of their SDP's sprop-* parameters
 * but send VPS/SPS/PPS in-band before every keyframe.  FFmpeg then writes an
 * hvcC with no VPS, or (tagged hvc1) an empty one and strips the in-band
 * copies; no browser decoder can be configured from that.  For those streams
 * the pipeline asks FFmpeg for hev1, which keeps the in-band copies, and
 * builds a complete hvcC from the first keyframe with these helpers.
 */

const HEVC_VPS = 32, HEVC_SPS = 33, HEVC_PPS = 34;
const isParamSet = (t) => t === HEVC_VPS || t === HEVC_SPS || t === HEVC_PPS;

/** NAL arrays of an hvcC: Map<nalType, Buffer[]>, or null when malformed. */
function hvccArrays(rec) {
  if (!rec || rec.length < 23) return null;
  const out = new Map();
  let p = 23;
  for (let i = 0; i < rec[22]; i++) {
    if (p + 3 > rec.length) return null;
    const type = rec[p] & 0x3f;
    const n = rec.readUInt16BE(p + 1);
    p += 3;
    const list = out.get(type) || [];
    for (let j = 0; j < n; j++) {
      if (p + 2 > rec.length) return null;
      const len = rec.readUInt16BE(p);
      if (p + 2 + len > rec.length) return null;
      list.push(rec.subarray(p + 2, p + 2 + len));
      p += 2 + len;
    }
    out.set(type, list);
  }
  return out;
}

function hvccComplete(rec) {
  const a = hvccArrays(rec);
  return !!a && [HEVC_VPS, HEVC_SPS, HEVC_PPS].every((t) => (a.get(t) || []).length > 0);
}

/** A 4-byte length-prefixed access unit (as FFmpeg writes it) -> [{ type, data }]. */
function splitNals(au) {
  const out = [];
  let p = 0;
  while (p + 4 <= au.length) {
    const len = au.readUInt32BE(p);
    if (len === 0 || p + 4 + len > au.length) break;
    out.push({ type: (au[p + 4] >> 1) & 0x3f, data: au.subarray(p + 4, p + 4 + len) });
    p += 4 + len;
  }
  return out;
}

function joinNals(nals) {
  const parts = [];
  for (const n of nals) {
    const len = Buffer.allocUnsafe(4);
    len.writeUInt32BE(n.data.length, 0);
    parts.push(len, n.data);
  }
  return Buffer.concat(parts);
}

/** The in-band VPS/SPS/PPS of an access unit plus the rest of it, or null if one is missing. */
function inbandParamSets(au) {
  const nals = splitNals(au);
  const vps = nals.find((n) => n.type === HEVC_VPS);
  const sps = nals.find((n) => n.type === HEVC_SPS);
  const pps = nals.find((n) => n.type === HEVC_PPS);
  if (!vps || !sps || !pps) return null;
  return { vps: vps.data, sps: sps.data, pps: pps.data, rest: joinNals(nals.filter((n) => !isParamSet(n.type))) };
}

/** NAL payload with the emulation-prevention bytes (00 00 03) removed. */
function rbsp(nal) {
  const out = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out.push(nal[i]);
  }
  return Buffer.from(out);
}

class Bits {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  u(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.buf[this.pos >> 3];
      if (byte === undefined) throw new Error('SPS ends early');
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  ue() {
    let zeros = 0;
    while (this.u(1) === 0) if (++zeros > 31) throw new Error('bad exp-Golomb code in SPS');
    return 2 ** zeros - 1 + this.u(zeros);
  }
}

/** An HEVCDecoderConfigurationRecord (ISO/IEC 14496-15) built from one VPS, SPS and PPS. */
function buildHvcc(vps, sps, pps) {
  const b = new Bits(rbsp(sps));
  b.u(16);                              // NAL unit header
  b.u(4);                               // sps_video_parameter_set_id
  const maxSubLayersMinus1 = b.u(3);
  const temporalIdNesting = b.u(1);
  const ptlStart = b.pos >> 3;          // general profile_tier_level: 12 bytes, byte aligned
  b.pos += 96;
  const subProfile = [], subLevel = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) { subProfile.push(b.u(1)); subLevel.push(b.u(1)); }
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) b.u(2);
  for (let i = 0; i < maxSubLayersMinus1; i++) { if (subProfile[i]) b.pos += 88; if (subLevel[i]) b.pos += 8; }
  b.ue();                               // sps_seq_parameter_set_id
  const chroma = b.ue();
  if (chroma === 3) b.u(1);             // separate_colour_plane_flag
  b.ue(); b.ue();                       // picture width / height
  if (b.u(1)) { b.ue(); b.ue(); b.ue(); b.ue(); }  // conformance window
  const depthLuma = b.ue();
  const depthChroma = b.ue();

  const head = Buffer.alloc(23);
  head[0] = 1;
  b.buf.copy(head, 1, ptlStart, ptlStart + 12);  // profile space/tier/idc, compat and constraint flags, level
  head.writeUInt16BE(0xf000, 13);       // min_spatial_segmentation_idc 0
  head[15] = 0xfc;                      // parallelismType 0
  head[16] = 0xfc | chroma;
  head[17] = 0xf8 | depthLuma;
  head[18] = 0xf8 | depthChroma;
  head[21] = ((maxSubLayersMinus1 + 1) << 3) | (temporalIdNesting << 2) | 3;  // 4-byte NAL lengths
  head[22] = 3;
  const parts = [head];
  for (const [type, nal] of [[HEVC_VPS, vps], [HEVC_SPS, sps], [HEVC_PPS, pps]]) {
    const a = Buffer.alloc(5);
    a[0] = 0x80 | type;                 // array_completeness: every set of this type is here
    a.writeUInt16BE(1, 1);
    a.writeUInt16BE(nal.length, 3);
    parts.push(a, nal);
  }
  return Buffer.concat(parts);
}

/** An init segment (ftyp + moov) with its video track's hvcC replaced by `rec`. */
function replaceHvcc(init, rec) {
  const parents = [];
  const find = (start, end) => {
    for (const box of readBoxes(init, start, end)) {
      if (box.type === 'hvcC') return box;
      let kids = null;
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(box.type)) kids = box.body;
      else if (box.type === 'stsd') kids = box.body + 8;
      else if (box.type === 'hvc1' || box.type === 'hev1') kids = box.body + 78;
      if (kids === null) continue;
      parents.push(box);
      const hit = find(kids, box.end);
      if (hit) return hit;
      parents.pop();
    }
    return null;
  };
  const hvcC = find(0, init.length);
  if (!hvcC) return init;
  const box = Buffer.alloc(8 + rec.length);
  box.writeUInt32BE(box.length, 0);
  box.write('hvcC', 4, 'latin1');
  rec.copy(box, 8);
  const out = Buffer.concat([init.subarray(0, hvcC.start), box, init.subarray(hvcC.end)]);
  const delta = box.length - (hvcC.end - hvcC.start);
  for (const p of parents) out.writeUInt32BE(out.readUInt32BE(p.start) + delta, p.start);
  return out;
}

class Fmp4Parser extends EventEmitter {
  constructor() {
    super();
    this._chunks = [];
    this._len = 0;
    this._pos = 0;        // absolute stream offset of the first buffered byte
    this._ftyp = null;
    this._moof = null;    // { buf, pos }
    this.tracks = null;
  }

  push(chunk) {
    this._chunks.push(chunk);
    this._len += chunk.length;
    for (;;) {
      if (this._len < 8) return;
      const head = this._peek(16);
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (size === 1) {
        if (this._len < 16) return;
        size = Number(head.readBigUInt64BE(8));
      }
      if (size < 8 || size > MAX_BOX || !/^[\x20-\x7e]{4}$/.test(type)) {
        this.emit('error', new Error(`fMP4 stream corrupt (box '${type}' size ${size})`));
        this._chunks = []; this._len = 0;
        return;
      }
      if (this._len < size) return;
      const box = this._take(size);
      const pos = this._pos;
      this._pos += size;
      this._onBox(type, box, pos);
    }
  }

  _peek(n) {
    if (this._chunks[0].length >= n || this._chunks.length === 1) return this._chunks[0];
    const b = Buffer.concat(this._chunks);
    this._chunks = [b];
    return b;
  }

  _take(n) {
    let b;
    if (this._chunks[0].length >= n) {
      b = this._chunks[0].subarray(0, n);
      if (this._chunks[0].length === n) this._chunks.shift();
      else this._chunks[0] = this._chunks[0].subarray(n);
    } else {
      const all = Buffer.concat(this._chunks);
      b = all.subarray(0, n);
      this._chunks = all.length > n ? [all.subarray(n)] : [];
    }
    this._len -= n;
    return b;
  }

  _onBox(type, box, pos) {
    try {
      if (type === 'ftyp') { this._ftyp = Buffer.from(box); return; }
      if (type === 'moov') {
        this.tracks = parseMoov(box, { body: 8, end: box.length });
        const raw = Buffer.concat([this._ftyp || Buffer.alloc(0), box]);
        this.emit('init', { tracks: this.tracks, raw });
        return;
      }
      if (type === 'moof') { this._moof = { buf: Buffer.from(box), pos }; return; }
      if (type === 'mdat' && this._moof && this.tracks) {
        const frag = Buffer.concat([this._moof.buf, box]);
        const samples = this._parseFragment(frag, this._moof.pos);
        this._moof = null;
        this.emit('fragment', { raw: frag, samples, hasKey: samples.some((s) => s.kind === 'video' && s.isKey) });
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  _parseFragment(frag, moofPos) {
    const samples = [];
    const moof = { body: 8, end: frag.readUInt32BE(0) };
    for (const traf of readBoxes(frag, moof.body, moof.end)) {
      if (traf.type !== 'traf') continue;
      let track = null, baseOffset = 0, defDur = 0, defSize = 0, defFlags = 0, baseTime = 0;
      for (const b of readBoxes(frag, traf.body, traf.end)) {
        if (b.type === 'tfhd') {
          const flags = frag.readUInt32BE(b.body) & 0xffffff;
          let p = b.body + 4;
          track = this.tracks.get(frag.readUInt32BE(p)); p += 4;
          const d = track ? track.defaults : {};
          defDur = d.duration || 0; defSize = d.size || 0; defFlags = d.flags || 0;
          baseOffset = 0; // default-base-is-moof (or implicit first-traf moof base)
          if (flags & 0x1) { baseOffset = Number(frag.readBigUInt64BE(p)) - moofPos; p += 8; }
          if (flags & 0x2) p += 4;
          if (flags & 0x8) { defDur = frag.readUInt32BE(p); p += 4; }
          if (flags & 0x10) { defSize = frag.readUInt32BE(p); p += 4; }
          if (flags & 0x20) { defFlags = frag.readUInt32BE(p); p += 4; }
        } else if (b.type === 'tfdt') {
          baseTime = frag[b.body] === 1 ? Number(frag.readBigUInt64BE(b.body + 4)) : frag.readUInt32BE(b.body + 4);
        } else if (b.type === 'trun' && track) {
          const ver = frag[b.body];
          const flags = frag.readUInt32BE(b.body) & 0xffffff;
          let p = b.body + 4;
          const count = frag.readUInt32BE(p); p += 4;
          let dataOff = baseOffset;
          if (flags & 0x1) { dataOff = baseOffset + frag.readInt32BE(p); p += 4; }
          let firstFlags = null;
          if (flags & 0x4) { firstFlags = frag.readUInt32BE(p); p += 4; }
          let t = baseTime;
          for (let i = 0; i < count; i++) {
            let dur = defDur, size = defSize, sflags = defFlags, cts = 0;
            if (flags & 0x100) { dur = frag.readUInt32BE(p); p += 4; }
            if (flags & 0x200) { size = frag.readUInt32BE(p); p += 4; }
            if (flags & 0x400) { sflags = frag.readUInt32BE(p); p += 4; }
            else if (i === 0 && firstFlags !== null) sflags = firstFlags;
            if (flags & 0x800) { cts = ver === 1 ? frag.readInt32BE(p) : frag.readUInt32BE(p); p += 4; }
            if (dataOff + size > frag.length) break;
            samples.push({
              trackId: track.id,
              kind: track.kind,
              ptsUs: ((t + cts) / track.timescale) * 1e6,
              durationUs: (dur / track.timescale) * 1e6,
              isKey: track.kind !== 'video' || !(sflags & 0x10000),
              data: frag.subarray(dataOff, dataOff + size),
            });
            dataOff += size;
            t += dur;
          }
          baseTime = t;
        }
      }
    }
    return samples;
  }
}

module.exports = {
  Fmp4Parser, avcCodecString, hevcCodecString, hvccComplete, inbandParamSets, buildHvcc, replaceHvcc,
};
