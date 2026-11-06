'use strict';
/**
 * LookyLooky stream wire protocol.
 *
 * The browser side of this lives in public/js/camera/webcodecsClient.js and
 * must stay byte-for-byte in step with it.  Every binary message starts with
 *   [0] protocol version (0x01)
 *   [1] message type
 *
 *   STREAM_START  0x01  (no payload)          fresh subscription
 *   VIDEO_CONFIG  0x02  fourCC[4] csLen(u16 BE) codec[csLen] recLen(u32 BE) record[recLen]
 *   VIDEO_CHUNK   0x03  flags(u8) pts(i64 LE, µs) AVCC access unit
 *   AUDIO_CONFIG  0x04  "opus" channels(u8) sampleRate(u32 BE) preSkip(u16 BE)
 *   AUDIO_CHUNK   0x05  pts(i64 LE) len(u16 BE) opus packet
 *   STREAM_RESET  0x06  (no payload)          ffmpeg restarted, wait for config
 *   STREAM_ERROR  0x07  UTF-8 reason
 *   JPEG_FRAME    0x08  JPEG bytes            thumbnail tier
 *   AUDIO_PCM     0x09  pts(i64 LE) codec(u8: 0=mu-law) sampleRate(u32 BE) channels(u8) samples
 *                       for browsers with no AudioDecoder (Safari < 26, e.g. iPad 6th gen)
 *
 * VIDEO_CHUNK flags: bit0 keyframe, bit1 catch-up (replayed from the GOP cache
 * on subscribe; the client re-anchors its playout clock onto the newest one so
 * a late joiner starts at the live edge instead of a GOP behind it).
 */

const PROTOCOL_VERSION = 0x01;
const MSG = {
  STREAM_START: 0x01,
  VIDEO_CONFIG: 0x02,
  VIDEO_CHUNK:  0x03,
  AUDIO_CONFIG: 0x04,
  AUDIO_CHUNK:  0x05,
  STREAM_RESET: 0x06,
  STREAM_ERROR: 0x07,
  JPEG_FRAME:   0x08,
  AUDIO_PCM:    0x09,
};
const FLAG_KEYFRAME = 0x01;
const FLAG_CATCHUP  = 0x02;

function header(type, extra) {
  const b = Buffer.allocUnsafe(2 + extra);
  b[0] = PROTOCOL_VERSION;
  b[1] = type;
  return b;
}

const streamStart = () => header(MSG.STREAM_START, 0);
const streamReset = () => header(MSG.STREAM_RESET, 0);

function streamError(text) {
  const t = Buffer.from(String(text || 'stream error'), 'utf8');
  const b = header(MSG.STREAM_ERROR, t.length);
  t.copy(b, 2);
  return b;
}

function videoConfig(fourCC, codecString, record) {
  const cs = Buffer.from(codecString, 'utf8');
  const b = header(MSG.VIDEO_CONFIG, 4 + 2 + cs.length + 4 + record.length);
  b.write(fourCC.slice(0, 4).padEnd(4, ' '), 2, 'ascii');
  b.writeUInt16BE(cs.length, 6);
  cs.copy(b, 8);
  b.writeUInt32BE(record.length, 8 + cs.length);
  record.copy(b, 12 + cs.length);
  return b;
}

function videoChunk(ptsUs, isKey, data) {
  const b = header(MSG.VIDEO_CHUNK, 1 + 8 + data.length);
  b[2] = isKey ? FLAG_KEYFRAME : 0;
  b.writeBigInt64LE(BigInt(Math.round(ptsUs)), 3);
  data.copy(b, 11);
  return b;
}

/** A copy of a VIDEO_CHUNK with the catch-up flag set (cached messages are shared, never mutated). */
function asCatchup(msg) {
  const b = Buffer.from(msg);
  b[2] |= FLAG_CATCHUP;
  return b;
}

function audioConfig(channels, sampleRate, preSkip) {
  const b = header(MSG.AUDIO_CONFIG, 4 + 1 + 4 + 2);
  b.write('opus', 2, 'ascii');
  b[6] = channels;
  b.writeUInt32BE(sampleRate, 7);
  b.writeUInt16BE(preSkip || 0, 11);
  return b;
}

function audioChunk(ptsUs, data) {
  const b = header(MSG.AUDIO_CHUNK, 8 + 2 + data.length);
  b.writeBigInt64LE(BigInt(Math.round(ptsUs)), 2);
  b.writeUInt16BE(data.length, 10);
  data.copy(b, 12);
  return b;
}

function audioPcm(ptsUs, sampleRate, channels, samples) {
  const b = header(MSG.AUDIO_PCM, 8 + 1 + 4 + 1 + samples.length);
  b.writeBigInt64LE(BigInt(Math.round(ptsUs)), 2);
  b[10] = 0; // mu-law
  b.writeUInt32BE(sampleRate, 11);
  b[15] = channels;
  samples.copy(b, 16);
  return b;
}

function jpegFrame(jpeg) {
  const b = header(MSG.JPEG_FRAME, jpeg.length);
  jpeg.copy(b, 2);
  return b;
}

module.exports = {
  PROTOCOL_VERSION, MSG, FLAG_KEYFRAME, FLAG_CATCHUP,
  streamStart, streamReset, streamError, videoConfig, videoChunk, asCatchup,
  audioConfig, audioChunk, audioPcm, jpegFrame,
};
