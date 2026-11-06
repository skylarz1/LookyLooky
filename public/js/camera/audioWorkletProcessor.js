/**
 * Claudifer streaming audio processor (LookyLooky).
 *
 * Runs in the AudioWorkletGlobalScope (off-main-thread) and consumes Float32
 * PCM chunks posted over its MessagePort, outputting them into the render
 * quantum buffers at the context's sample rate.
 *
 * Why this exists: the previous per-packet AudioBufferSourceNode design
 * leaked native memory — Chrome's Web Audio engine retains finished
 * one-shot sources long after .close()/disconnect() is called, and at the
 * 50 Hz creation rate a 20 ms Opus stream implies, that grows unbounded
 * (gigabytes overnight).  Using a single persistent AudioWorkletNode per
 * client sidesteps the issue entirely: no node churn, no leak.
 *
 * Main thread posts:  port.postMessage({ planes: Float32Array[] }, [transferables])
 *   - planes.length        = channel count (1 mono, 2 stereo, …)
 *   - planes[c].length     = sample frames in this chunk
 *
 * A hard cap on the internal queue depth protects against runaway growth
 * in corner cases (decoder producing faster than playback, or a long
 * stall).  When over the cap we drop the oldest chunks.
 */

const MAX_QUEUE_FRAMES = 48000;  // ~1 s at 48 kHz — plenty of jitter headroom

class ClaudiferAudioBufferProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._queue = [];        // each entry: { planes: Float32Array[], offset: number }
    this._queuedFrames = 0;  // total unread frames across the queue
    this.port.onmessage = (ev) => this._onMessage(ev.data);
  }

  _onMessage(data) {
    if (data?.type === 'flush') {
      this._queue = [];
      this._queuedFrames = 0;
      return;
    }
    const planes = data?.planes;
    if (!Array.isArray(planes) || planes.length === 0) return;
    const frames = planes[0].length;
    if (!frames) return;

    this._queue.push({ planes, offset: 0 });
    this._queuedFrames += frames;

    // Cap the queue.  Dropping the oldest keeps us close to live instead
    // of letting a transient stall snowball into long-term latency.
    while (this._queuedFrames > MAX_QUEUE_FRAMES && this._queue.length > 1) {
      const dropped = this._queue.shift();
      this._queuedFrames -= (dropped.planes[0].length - dropped.offset);
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const needed = output[0].length;  // typically 128
    const outChans = output.length;

    let written = 0;
    while (written < needed && this._queue.length > 0) {
      const chunk = this._queue[0];
      const chunkFrames = chunk.planes[0].length;
      const available = chunkFrames - chunk.offset;
      const toWrite = Math.min(needed - written, available);

      for (let c = 0; c < outChans; c++) {
        // Fan out mono→stereo by reading the last available plane when the
        // output has more channels than the source.
        const src = chunk.planes[Math.min(c, chunk.planes.length - 1)];
        output[c].set(src.subarray(chunk.offset, chunk.offset + toWrite), written);
      }

      chunk.offset += toWrite;
      this._queuedFrames -= toWrite;
      written += toWrite;

      if (chunk.offset >= chunkFrames) this._queue.shift();
    }

    // Underrun — fill with silence.  Next posted chunk picks up the flow.
    if (written < needed) {
      for (let c = 0; c < outChans; c++) output[c].fill(0, written);
    }

    return true;  // keep the processor alive even when the queue drains
  }
}

registerProcessor('claudifer-audio-buffer', ClaudiferAudioBufferProcessor);
