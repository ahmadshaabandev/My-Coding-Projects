/*
 * recorder.js: microphone capture for Mommy.
 *
 * Records the microphone with the Web Audio API and returns a 16 kHz mono PCM16 WAV Blob,
 * which is what the server's ASR expects. Everything stays in memory: nothing is written
 * to storage, logged or kept after stop(). The microphone is released (every track
 * stopped, the AudioContext closed) as soon as recording ends or is cancelled.
 *
 * Capture uses an AudioWorklet (its code is loaded from an in-memory blob: URL, so no
 * extra file or network request is needed) and falls back to a ScriptProcessorNode on
 * browsers without AudioWorklet. The AudioContext runs at the device rate (many browsers
 * cannot connect a microphone to a context at another rate); the samples are then
 * low-pass filtered and resampled to 16 kHz in JavaScript.
 *
 * Browser use (classic script, no modules):
 *
 *   const rec = new MommyRecorder.Recorder({
 *     maxSeconds: 120,
 *     onLevel(level, seconds) { ... },   // live level meter: level 0..1, elapsed seconds
 *     onLimit() { ... },                 // the maximum length was reached; call stop()
 *   });
 *   await rec.start();                   // asks for the microphone (needs a user gesture)
 *   const wavBlob = await rec.stop();    // Promise<Blob type "audio/wav">
 *   rec.cancel();                        // or: drop the recording and release the mic
 *
 * The pure helpers (downsample, encodeWav, levelOf) are also exported to Node through
 * module.exports, so they can be unit-tested without a browser.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MommyRecorder = api;
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /** Output sample rate expected by the server's speech recogniser. */
  const TARGET_RATE = 16000;
  /** Default and absolute maximum recording length, in seconds (the server limit). */
  const MAX_SECONDS = 120;
  /** Samples per message from the capture node (about 85 ms at 48 kHz). */
  const CHUNK = 4096;
  /** Zero crossings of the windowed-sinc kernel on each side (filter sharpness). */
  const SINC_ZEROS = 8;
  /** Fractional phases in the precomputed polyphase kernel table. */
  const PHASES = 256;
  /** Fraction of the output Nyquist frequency used as the low-pass cutoff. */
  const CUTOFF = 0.94;

  /*
   * AudioWorklet processor: mixes the input channels to mono and posts batches of CHUNK
   * samples to the main thread. 'flush' posts what is buffered, then 'flushed'.
   */
  const WORKLET_SOURCE = [
    'class MommyCaptureProcessor extends AudioWorkletProcessor {',
    '  constructor() {',
    '    super();',
    '    this._buf = new Float32Array(' + CHUNK + ');',
    '    this._n = 0;',
    '    this.port.onmessage = (e) => {',
    "      if (e.data === 'flush') { this._emit(); this.port.postMessage('flushed'); }",
    '    };',
    '  }',
    '  _emit() {',
    '    if (this._n === 0) return;',
    '    const out = this._buf.slice(0, this._n);',
    '    this._n = 0;',
    '    this.port.postMessage(out, [out.buffer]);',
    '  }',
    '  process(inputs) {',
    '    const input = inputs[0];',
    '    if (input && input.length > 0) {',
    '      const chs = input.length;',
    '      const len = input[0].length;',
    '      for (let i = 0; i < len; i++) {',
    '        let s = 0;',
    '        for (let c = 0; c < chs; c++) s += input[c][i];',
    '        this._buf[this._n++] = s / chs;',
    '        if (this._n === this._buf.length) this._emit();',
    '      }',
    '    }',
    '    return true;',
    '  }',
    '}',
    "registerProcessor('mommy-capture', MommyCaptureProcessor);",
  ].join('\n');

  // ---------------------------------------------------------------------------
  // Pure signal helpers (also used by the Node tests)
  // ---------------------------------------------------------------------------

  const kernelCache = new Map();

  /**
   * Polyphase windowed-sinc kernel table for a downsampling ratio.
   * Row p holds the 2*half taps for a fractional offset of p/PHASES input samples,
   * normalised to unit DC gain.
   */
  function kernelTable(ratio) {
    const cacheKey = ratio.toFixed(9);
    const cached = kernelCache.get(cacheKey);
    if (cached) return cached;
    const half = Math.ceil(SINC_ZEROS * ratio);
    const taps = 2 * half;
    const fc = (0.5 / ratio) * CUTOFF; // cutoff in cycles per input sample
    const table = new Float32Array((PHASES + 1) * taps);
    for (let p = 0; p <= PHASES; p++) {
      const frac = p / PHASES;
      let sum = 0;
      const row = p * taps;
      for (let j = 0; j < taps; j++) {
        const x = j - half + 1 - frac; // distance from the output instant, in input samples
        const t = 2 * fc * x;
        const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
        const win = Math.abs(x) >= half ? 0 : 0.5 * (1 + Math.cos((Math.PI * x) / half));
        const h = sinc * win;
        table[row + j] = h;
        sum += h;
      }
      for (let j = 0; j < taps; j++) table[row + j] /= sum;
    }
    const entry = { table, half, taps };
    kernelCache.set(cacheKey, entry);
    return entry;
  }

  /**
   * Resample mono float samples from inRate to outRate (default 16 kHz).
   *
   * Downsampling uses a Hann-windowed sinc low-pass at the output Nyquist frequency, so
   * frequencies the output cannot hold are removed instead of aliasing. Upsampling (rare:
   * a device below 16 kHz) uses linear interpolation.
   *
   * @param {Float32Array|number[]} input
   * @param {number} inRate
   * @param {number} [outRate]
   * @returns {Float32Array}
   */
  function downsample(input, inRate, outRate) {
    const target = outRate === undefined ? TARGET_RATE : outRate;
    if (!(inRate > 0) || !(target > 0)) {
      throw new RangeError('sample rates must be positive');
    }
    const n = input.length;
    if (n === 0) return new Float32Array(0);
    if (inRate === target) return Float32Array.from(input);
    const ratio = inRate / target;
    const outLen = Math.floor((n * target) / inRate);
    const out = new Float32Array(outLen);
    if (ratio < 1) {
      for (let i = 0; i < outLen; i++) {
        const x = i * ratio;
        const i0 = Math.floor(x);
        const i1 = Math.min(i0 + 1, n - 1);
        const f = x - i0;
        out[i] = input[i0] * (1 - f) + input[i1] * f;
      }
      return out;
    }
    const { table, half, taps } = kernelTable(ratio);
    for (let i = 0; i < outLen; i++) {
      const center = i * ratio;
      const c0 = Math.floor(center);
      const phase = Math.round((center - c0) * PHASES);
      const row = phase * taps;
      const first = c0 - half + 1;
      let acc = 0;
      if (first >= 0 && first + taps <= n) {
        for (let j = 0; j < taps; j++) acc += input[first + j] * table[row + j];
      } else {
        for (let j = 0; j < taps; j++) {
          const k = first + j;
          if (k >= 0 && k < n) acc += input[k] * table[row + j];
        }
      }
      out[i] = acc;
    }
    return out;
  }

  /**
   * Encode mono float samples (-1..1) as a PCM16 little-endian WAV file.
   * Values outside -1..1 are clipped and NaN becomes silence.
   *
   * @param {Float32Array|number[]} samples
   * @param {number} [sampleRate]
   * @returns {ArrayBuffer} the complete file (44-byte header + data)
   */
  function encodeWav(samples, sampleRate) {
    const rate = sampleRate === undefined ? TARGET_RATE : sampleRate;
    const dataBytes = samples.length * 2;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const v = new DataView(buffer);
    const ascii = (offset, text) => {
      for (let i = 0; i < text.length; i++) v.setUint8(offset + i, text.charCodeAt(i));
    };
    ascii(0, 'RIFF');
    v.setUint32(4, 36 + dataBytes, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    v.setUint32(16, 16, true); // fmt chunk size
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); // byte rate
    v.setUint16(32, 2, true); // block align
    v.setUint16(34, 16, true); // bits per sample
    ascii(36, 'data');
    v.setUint32(40, dataBytes, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
      let s = samples[i];
      if (!(s === s)) s = 0; // NaN
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      v.setInt16(offset, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
      offset += 2;
    }
    return buffer;
  }

  /**
   * Meter level (0..1) of a block of samples: its RMS on a -60..0 dBFS scale.
   * @param {Float32Array} frame
   * @returns {number}
   */
  function levelOf(frame) {
    if (!frame || frame.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    if (rms <= 0) return 0;
    const db = 20 * Math.log10(rms);
    return Math.max(0, Math.min(1, (db + 60) / 60));
  }

  /** Concatenate Float32Array chunks into one array. */
  function concat(chunks, total) {
    const out = new Float32Array(total);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Browser recorder
  // ---------------------------------------------------------------------------

  let openStreams = 0;

  function audioContextClass() {
    if (typeof window === 'undefined') return null;
    return window.AudioContext || window.webkitAudioContext || null;
  }

  /** True when this browser, on this page, can record the microphone. */
  function isSupported() {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      !!audioContextClass()
    );
  }

  /** Microphone recorder producing a 16 kHz mono PCM16 WAV Blob. */
  class Recorder {
    /**
     * @param {{maxSeconds?: number, onLevel?: (level:number, seconds:number) => void,
     *          onLimit?: () => void}} [options]
     */
    constructor(options) {
      const opts = options || {};
      const max = Number(opts.maxSeconds) || MAX_SECONDS;
      this.maxSeconds = Math.max(1, Math.min(MAX_SECONDS, max));
      this.onLevel = typeof opts.onLevel === 'function' ? opts.onLevel : null;
      this.onLimit = typeof opts.onLimit === 'function' ? opts.onLimit : null;
      this._state = 'idle'; // idle -> starting -> recording -> stopped
      this._abort = false;
      this._chunks = [];
      this._total = 0;
      this._maxSamples = 0;
      this._limitHit = false;
      this._stream = null;
      this._ctx = null;
      this._source = null;
      this._node = null;
      this._sink = null;
      this._flushWaiter = null;
      /** "worklet" or "script-processor" once recording. */
      this.engine = null;
    }

    /** "idle", "starting", "recording" or "stopped". */
    get state() {
      return this._state;
    }

    /** Seconds recorded so far. */
    get seconds() {
      return this._ctx ? this._total / this._ctx.sampleRate : 0;
    }

    /**
     * Ask for the microphone and start recording. Rejects with the getUserMedia error
     * (for example NotAllowedError) or an AbortError when cancel() was called meanwhile.
     */
    async start() {
      if (this._state !== 'idle') throw new Error('This recorder has already been used.');
      if (!isSupported()) {
        const err = new Error('Recording is not supported here.');
        err.name = 'NotSupportedError';
        throw err;
      }
      this._state = 'starting';
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        this._stream = stream;
        openStreams++;
        this._checkAbort();
        const AC = audioContextClass();
        const ctx = new AC();
        this._ctx = ctx;
        if (ctx.state === 'suspended') await ctx.resume();
        this._checkAbort();
        this._maxSamples = Math.floor(this.maxSeconds * ctx.sampleRate);
        this._source = ctx.createMediaStreamSource(stream);
        this._sink = ctx.createGain();
        this._sink.gain.value = 0; // keep the graph pulled without playing anything back
        this._sink.connect(ctx.destination);
        let worklet = false;
        if (ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
          try {
            await this._startWorklet(ctx);
            worklet = true;
          } catch (e) {
            worklet = false;
          }
        }
        this._checkAbort();
        if (!worklet) this._startScriptProcessor(ctx);
        this._state = 'recording';
      } catch (err) {
        this._release();
        this._state = 'stopped';
        throw err;
      }
    }

    _checkAbort() {
      if (this._abort) {
        const err = new Error('Recording was cancelled.');
        err.name = 'AbortError';
        throw err;
      }
    }

    async _startWorklet(ctx) {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(ctx, 'mommy-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.onmessage = (e) => {
        if (e.data === 'flushed') {
          if (this._flushWaiter) this._flushWaiter();
        } else if (e.data instanceof Float32Array) {
          this._onFrame(e.data);
        }
      };
      this._source.connect(node);
      node.connect(this._sink);
      this._node = node;
      this.engine = 'worklet';
    }

    _startScriptProcessor(ctx) {
      const node = ctx.createScriptProcessor(CHUNK, 1, 1);
      node.onaudioprocess = (e) => {
        this._onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      this._source.connect(node);
      node.connect(this._sink);
      this._node = node;
      this.engine = 'script-processor';
    }

    _onFrame(frame) {
      if (this._state !== 'recording' || this._limitHit) return;
      const room = this._maxSamples - this._total;
      const piece = frame.length > room ? frame.subarray(0, room) : frame;
      if (piece.length > 0) {
        this._chunks.push(piece);
        this._total += piece.length;
      }
      if (this.onLevel) {
        try {
          this.onLevel(levelOf(piece), this.seconds);
        } catch (e) {
          /* a meter error must not stop the recording */
        }
      }
      if (this._total >= this._maxSamples) {
        this._limitHit = true;
        if (this.onLimit) setTimeout(() => this.onLimit && this.onLimit(), 0);
      }
    }

    /** Ask the worklet for its buffered samples, waiting at most 250 ms. */
    _flush() {
      if (!this._node || this.engine !== 'worklet') return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(done, 250);
        const self = this;
        function done() {
          clearTimeout(timer);
          self._flushWaiter = null;
          resolve();
        }
        this._flushWaiter = done;
        try {
          this._node.port.postMessage('flush');
        } catch (e) {
          done();
        }
      });
    }

    /**
     * Stop recording, release the microphone and return the WAV Blob
     * (16 kHz, mono, PCM16). The recorded samples are dropped from memory.
     * @returns {Promise<Blob>}
     */
    async stop() {
      if (this._state === 'starting') {
        this.cancel();
        const err = new Error('Recording had not started yet.');
        err.name = 'AbortError';
        throw err;
      }
      if (this._state !== 'recording') throw new Error('Not recording.');
      await this._flush();
      this._state = 'stopped';
      const rate = this._ctx.sampleRate;
      const raw = concat(this._chunks, this._total);
      this._chunks = [];
      this._total = 0;
      this._release();
      const pcm = downsample(raw, rate, TARGET_RATE);
      return new Blob([encodeWav(pcm, TARGET_RATE)], { type: 'audio/wav' });
    }

    /** Drop the recording (if any) and release the microphone. Safe to call twice. */
    cancel() {
      this._abort = true;
      if (this._state === 'recording') this._state = 'stopped';
      this._chunks = [];
      this._total = 0;
      this._release();
    }

    _release() {
      if (this._flushWaiter) this._flushWaiter();
      if (this._node) {
        try {
          if (this._node.port) this._node.port.onmessage = null;
          if ('onaudioprocess' in this._node) this._node.onaudioprocess = null;
          this._node.disconnect();
        } catch (e) {
          /* already disconnected */
        }
        this._node = null;
      }
      if (this._source) {
        try {
          this._source.disconnect();
        } catch (e) {
          /* already disconnected */
        }
        this._source = null;
      }
      this._sink = null;
      if (this._stream) {
        for (const track of this._stream.getTracks()) track.stop();
        this._stream = null;
        openStreams--;
      }
      if (this._ctx) {
        const ctx = this._ctx;
        this._ctx = null;
        if (ctx.state !== 'closed') ctx.close().catch(() => {});
      }
    }
  }

  return {
    TARGET_RATE,
    MAX_SECONDS,
    Recorder,
    isSupported,
    downsample,
    encodeWav,
    levelOf,
    /** Number of microphone streams currently held by recorders (for tests). */
    openStreams: () => openStreams,
  };
});
