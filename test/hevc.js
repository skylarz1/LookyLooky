'use strict';
/**
 * H.265 streams whose SDP has no VPS (server/fmp4.js, "HEVC parameter sets").
 * Offline: the parameter sets are the ones a Uniview camera sends in-band,
 * and the init segments are built here.  `node test/hevc.js`
 */

const assert = require('assert');
const F = require('../server/fmp4');

const VPS = Buffer.from('40010c01ffff01600000030000030000030000030096ac0c0000030004000003003d40', 'hex');
const SPS = Buffer.from('42010101600000030000030000030000030096a00280802d1636b924c9ae59c020000003002000000301e1', 'hex');
const PPS = Buffer.from('4401e076b02640', 'hex');
// The first 22 bytes of the hvcC FFmpeg writes for that stream (the header; its arrays lack the VPS).
const FFMPEG_HEAD = '01016000000000000000000096f000fcfdf8f800000f';

const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };

/** ftyp + moov with one 1280x720 hev1 video track carrying `hvcC`. */
function initWith(hvcC) {
  const tkhd = box('tkhd', Buffer.alloc(4), Buffer.alloc(8), u32(1), Buffer.alloc(68));
  const mdhd = box('mdhd', Buffer.alloc(4), Buffer.alloc(8), u32(90000), Buffer.alloc(8));
  const hdlr = box('hdlr', Buffer.alloc(8), Buffer.from('vide'), Buffer.alloc(13));
  const entry = Buffer.alloc(78);
  entry.writeUInt16BE(1280, 24);
  entry.writeUInt16BE(720, 26);
  const stsd = box('stsd', Buffer.alloc(4), u32(1), box('hev1', entry, box('hvcC', hvcC)));
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', box('stbl', stsd))));
  return Buffer.concat([box('ftyp', Buffer.from('isom'), u32(512)), box('moov', trak)]);
}

function parseInit(raw) {
  const p = new F.Fmp4Parser();
  let track = null, error = null;
  p.on('init', (i) => { track = [...i.tracks.values()][0]; });
  p.on('error', (e) => { error = e; });
  p.push(raw);
  if (error) throw error;
  return track;
}

const nal = (n) => Buffer.concat([u32(n.length), n]);
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS  ${name}`); };

check('an empty hvcC parses without throwing and is marked incomplete', () => {
  const t = parseInit(initWith(Buffer.alloc(0)));
  assert.strictEqual(t.codec, 'hevc');
  assert.strictEqual(t.complete, false);
  assert.strictEqual(t.codecString, null);
});

const rec = F.buildHvcc(VPS, SPS, PPS);

check('an hvcC with SPS and PPS but no VPS is incomplete', () => {
  const noVps = Buffer.concat([rec.subarray(0, 22), Buffer.from([2]), rec.subarray(23 + 5 + VPS.length)]);
  assert.strictEqual(F.hvccComplete(noVps), false);
  assert.strictEqual(parseInit(initWith(noVps)).complete, false);
});

check('the built hvcC matches FFmpeg\'s header and holds all three sets', () => {
  assert.strictEqual(rec.subarray(0, 22).toString('hex'), FFMPEG_HEAD);
  assert.strictEqual(rec[22], 3);
  assert.ok(F.hvccComplete(rec));
  assert.strictEqual(F.hevcCodecString(rec), 'hvc1.1.6.L150');
});

check('in-band parameter sets are split from the picture', () => {
  const idr = Buffer.from('2601af0000', 'hex');
  const ps = F.inbandParamSets(Buffer.concat([nal(VPS), nal(SPS), nal(PPS), nal(idr)]));
  assert.ok(ps.vps.equals(VPS) && ps.sps.equals(SPS) && ps.pps.equals(PPS));
  assert.ok(ps.rest.equals(nal(idr)));
  assert.strictEqual(F.inbandParamSets(nal(idr)), null);
});

check('replacing the hvcC fixes every box size in the init segment', () => {
  const fixed = F.replaceHvcc(initWith(Buffer.alloc(0)), rec);
  const t = parseInit(fixed);
  assert.strictEqual(t.complete, true);
  assert.ok(t.record.equals(rec));
  assert.strictEqual(`${t.width}x${t.height}`, '1280x720');
  assert.strictEqual(t.codecString, 'hvc1.1.6.L150');
});

console.log(`\n${passed}/5 checks passed`);
