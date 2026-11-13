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
 *     onPhrase(phrase) { ... },          // optional: a phrase ended (see below)
 *   });
 *   await rec.start();                   // asks for the microphone (needs a user gesture)
 *   const wavBlob = await rec.stop();    // Promise<Blob type "audio/wav">
 *   rec.tail;                            // with onPhrase: what came after the last phrase
 *   rec.cancel();                        // or: drop the recording and release the mic
 *
 * Phrases (live recitation). With onPhrase, the 16 kHz signal is also cut into phrases
 * while recording (PhraseSegmenter: an energy voice activity detector that follows the
 * noise floor). Each phrase is {samples: Float32Array at 16 kHz with about 0.2 s of
 * padding, start, end (seconds into the recording), speech (seconds of speech in it),
 * forced (cut because the child spoke for MAX_PHRASE_S without a pause)}; the phrases
 * follow each other without overlap. stop() still returns the whole recording, and then
 * rec.tail holds the rest after the last phrase ({samples, start, end, speech}; samples
 * empty when no speech came after it), or null without onPhrase. Nothing is emitted
 * after stop() or cancel().
 *
 * The pure helpers (downsample, encodeWav, levelOf, StreamResampler, PhraseSegmenter,
 * concatSamples) are also exported to Node through module.exports, so they can be
 * unit-tested without a browser.
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

  /** Concatenate sample arrays (any number) into one Float32Array. */
  function concatSamples(list) {
    let total = 0;
    for (const c of list) total += c.length;
    return concat(list, total);
  }

  /**
   * Streaming version of downsample(): push() the input in chunks of any size and get
   * the output samples as soon as their filter window is complete; flush() at the end
   * gives the rest. The concatenated output equals downsample() of the whole input (the
   * same kernel, in the same order), so the phrases cut while recording hold exactly the
   * samples of the final recording.
   */
  class StreamResampler {
    constructor(inRate, outRate) {
      this.inRate = inRate;
      this.outRate = outRate === undefined ? TARGET_RATE : outRate;
      if (!(this.inRate > 0) || !(this.outRate > 0)) throw new RangeError('sample rates must be positive');
      this.ratio = this.inRate / this.outRate;
      this._buf = new Float32Array(0); // input samples from absolute index _offset on
      this._offset = 0;
      this._inTotal = 0;
      this._next = 0; // index of the next output sample
      this._kernel = this.ratio > 1 ? kernelTable(this.ratio) : null;
    }

    /** Output samples whose window lies in the input received so far. */
    push(input) {
      if (input && input.length) {
        const merged = new Float32Array(this._buf.length + input.length);
        merged.set(this._buf, 0);
        merged.set(input, this._buf.length);
        this._buf = merged;
        this._inTotal += input.length;
      }
      return this._emit(false);
    }

    /** The remaining output samples (the input is over). */
    flush() {
      return this._emit(true);
    }

    _emit(final) {
      const n = this._inTotal;
      const outLen = Math.floor((n * this.outRate) / this.inRate);
      const out = [];
      const ratio = this.ratio;
      const buf = this._buf;
      const off = this._offset;
      const at = (k) => (k >= 0 && k < n ? buf[k - off] : 0);
      while (this._next < outLen) {
        const i = this._next;
        if (this.ratio === 1) {
          out.push(at(i));
        } else if (ratio < 1) {
          const x = i * ratio;
          const i0 = Math.floor(x);
          const i1 = Math.min(i0 + 1, n - 1);
          if (!final && i0 + 1 >= n) break;
          const f = x - i0;
          out.push(at(i0) * (1 - f) + at(i1) * f);
        } else {
          const { table, half, taps } = this._kernel;
          const center = i * ratio;
          const c0 = Math.floor(center);
          if (!final && c0 + half >= n) break;
          const phase = Math.round((center - c0) * PHASES);
          const row = phase * taps;
          const first = c0 - half + 1;
          let acc = 0;
          for (let j = 0; j < taps; j++) {
            const k = first + j;
            if (k >= 0 && k < n) acc += buf[k - off] * table[row + j];
          }
          out.push(acc);
        }
        this._next++;
      }
      // Keep only the input that later outputs can still need.
      const keepFrom = this.ratio > 1 ? Math.floor(this._next * ratio) - this._kernel.half : Math.floor(this._next * ratio) - 1;
      const drop = Math.max(0, Math.min(keepFrom - off, buf.length));
      if (drop > 0) {
        this._buf = buf.slice(drop);
        this._offset = off + drop;
      }
      return Float32Array.from(out);
    }
  }

  /*
   * Phrase segmentation (live recitation). The numbers, at 16 kHz in 20 ms frames:
   *
   * - A frame is speech when its level is SPEECH_DB (10 dB) above the noise floor and
   *   above MIN_SPEECH_DBFS (-50 dBFS). The floor is the lowest 60 ms level of the last
   *   FLOOR_WINDOW_S (3 s; minimum statistics): it drops at once to a quieter room, and
   *   rises at most FLOOR_RISE_DB_PER_S (4 dB/s), so a fan that makes the room 20 dB
   *   louder is learnt in about 5 s, while a long stretch of speech (whose gaps between
   *   words come back near the floor) does not become the floor. The browser's noise suppression and gain control
   *   are on, so a quiet room sits around -70 to -55 dBFS and a child's voice around -35
   *   to -15 dBFS: 10 dB above the floor keeps the soft ends of words.
   * - A phrase ends after END_SILENCE_S (0.65 s) of silence, once it holds MIN_SPEECH_S
   *   (0.4 s) of speech. The pauses between words of a sentence read aloud are under
   *   about 0.3 s, and a hesitation inside a word is shorter still; children reading
   *   word by word pause 0.5-1 s and more at commas and full stops. 0.65 s therefore cuts
   *   at those pauses, not inside a word, while the result follows the child within a
   *   second. A child reading fluently pauses only 0.2-0.5 s between sentences, so with
   *   0.65 s alone a paragraph ran to the forced cut and nothing was coloured for 18 s.
   *   So once a phrase holds more than LONG_SPEECH_S (1.5 s) of speech and is dense speech
   *   (speech for at least DENSE_SPEECH, 60 %, of its time: a fluent reader), the silence
   *   needed shrinks with its speech, down to SHORT_END_SILENCE_S (0.3 s) at LONGER_SPEECH_S
   *   (3 s): a fluent reader's phrase ends at a sentence pause after 2-3 sentences or
   *   fewer. A word-by-word reader (much of the time between words: 35-45 % speech) keeps
   *   0.65 s: shorter phrases of a few words made Whisper's errors worse for those readers.
   *   A phrase with less speech than 0.4 s (a cough, a click, a one-syllable word) is not
   *   sent alone: Whisper is unreliable on such short clips (it tends to write a word that
   *   was not said); it stays in the next phrase, or the tail. A burst of less than
   *   CLICK_S (0.15 s) of speech followed by DROP_SILENCE_S (1 s) of silence is dropped
   *   as a noise (no word is that short).
   * - Each phrase has PAD_S (0.2 s) of the signal before its first and after its last
   *   speech frame (soft starts and ends of words, and some silence for Whisper), never
   *   reaching into the previous phrase.
   * - A phrase is cut anyway after MAX_PHRASE_S (7 s), in the middle of the longest pause
   *   (frames that are not speech) of its last CUT_SEARCH_S (4 s) but not its last 0.5 s
   *   - the gap between two sentences or two words, not a quiet sound inside a word -
   *   or, with no pause of 100 ms there, at its quietest 100 ms: the child sees progress at
   *   least every 7 s or so even without a pause long enough, and one decode stays short. There is no padding at a
   *   forced cut (the next phrase starts exactly there, so no word is decoded twice).
   */
  const VAD = {
    FRAME_S: 0.02,
    SPEECH_DB: 10,
    MIN_SPEECH_DBFS: -50,
    FLOOR_WINDOW_S: 3,
    FLOOR_SMOOTH_S: 0.06,
    FLOOR_RISE_DB_PER_S: 4,
    MIN_FLOOR_DBFS: -90,
    END_SILENCE_S: 0.65,
    LONG_SPEECH_S: 1.5,
    LONGER_SPEECH_S: 3,
    SHORT_END_SILENCE_S: 0.3,
    DENSE_SPEECH: 0.6,
    MIN_SPEECH_S: 0.4,
    CLICK_S: 0.15,
    DROP_SILENCE_S: 1.0,
    PAD_S: 0.2,
    TAIL_LEAD_S: 1.0,
    MAX_PHRASE_S: 7,
    CUT_SEARCH_S: 4,
  };

  /**
   * Segmenter numbers that differ by language (live recitation). Arabic has no quick
   * recogniser: every phrase goes to Whisper, which loses words at the cuts of short
   * phrases (a fluent Arabic reading of 98 s, Piper-spoken: 50 / 60 errors of 177 words,
   * clean / noisy, with 8-9 phrases of 12 s; 58 / 69 with 20-22 phrases of 4.6 s; 52 / 63
   * with 13-15 phrases of 7 s). So an Arabic phrase shrinks its end silence only after
   * 3 s of speech (0.3 s at 5 s) and is cut at 9 s at the latest; English and French
   * (quick recognisers, the same errors either way) keep the defaults of VAD.
   */
  const PHRASE_OPTIONS = {
    ar: { LONG_SPEECH_S: 3, LONGER_SPEECH_S: 5, MAX_PHRASE_S: 9, CUT_SEARCH_S: 5 },
  };

  /** The PhraseSegmenter options of a reading in `lang` (a copy; {} for the defaults). */
  function phraseOptionsFor(lang) {
    return Object.assign({}, PHRASE_OPTIONS[lang] || {});
  }

  /** Level in dBFS of a block of samples (RMS; -120 for silence). */
  function dbfs(samples, from, to) {
    let sum = 0;
    for (let i = from; i < to; i++) sum += samples[i] * samples[i];
    const ms = sum / Math.max(1, to - from);
    return ms > 1e-12 ? 10 * Math.log10(ms) : -120;
  }

  /**
   * Cuts a 16 kHz signal into phrases while it is being recorded (see VAD above).
   * push(samples) returns the phrases that ended (usually none); finish() returns the
   * rest after the last phrase (the tail). Pure: no browser API, unit-tested in Node.
   * options: {rate (16000), ...any VAD number in camelCase or VAD's own name}.
   */
  class PhraseSegmenter {
    constructor(options) {
      const o = options || {};
      this.rate = o.rate || TARGET_RATE;
      const v = Object.assign({}, VAD);
      for (const key of Object.keys(VAD)) if (typeof o[key] === 'number') v[key] = o[key];
      this.v = v;
      this.frame = Math.round(v.FRAME_S * this.rate);
      this._samples = new Float32Array(0); // signal from absolute sample _base on
      this._base = 0;
      this._total = 0; // samples received
      this._frames = []; // {db, speech} of every frame from frame index _frameBase on
      this._frameBase = 0;
      this._smooth = []; // recent frame energies for the 100 ms level
      this._floorHist = []; // 100 ms levels of the last FLOOR_WINDOW_S
      this.floor = null; // noise floor, dBFS
      this.consumed = 0; // absolute sample where the next phrase may start
      this._region = null; // {start, lastSpeechEnd, speechFrames}
      this._silence = 0; // frames of silence since the last speech frame
      this.phrases = 0;
    }

    /** Feed samples; returns the phrases that ended, in order. */
    push(input) {
      const out = [];
      if (!input || !input.length) return out;
      const merged = new Float32Array(this._samples.length + input.length);
      merged.set(this._samples, 0);
      merged.set(input, this._samples.length);
      this._samples = merged;
      this._total += input.length;
      const f = this.frame;
      // Frames start at absolute multiples of the frame length.
      let next = (this._frameBase + this._frames.length) * f;
      while (next + f <= this._total) {
        this._frame(next, out);
        next += f;
      }
      this._trim();
      return out;
    }

    /** The tail: everything after the last phrase (or since the start), then reset. */
    finish() {
      const v = this.v;
      const r = this._region;
      const end = this._total;
      let start;
      let speech = 0;
      if (r) {
        start = Math.max(this.consumed, r.start - Math.round(v.TAIL_LEAD_S * this.rate), this._base);
        speech = (r.speechFrames * this.frame) / this.rate;
      } else {
        start = end;
      }
      // A tail with less speech than a click is no speech: nothing to decode.
      const samples = speech >= v.CLICK_S ? this._slice(start, end) : new Float32Array(0);
      if (!samples.length) start = end;
      this._region = null;
      return { samples, start: start / this.rate, end: end / this.rate, speech: samples.length ? speech : 0 };
    }

    _slice(from, to) {
      const a = Math.max(0, from - this._base);
      const b = Math.max(a, Math.min(this._samples.length, to - this._base));
      return this._samples.slice(a, b);
    }

    _frame(at, out) {
      const v = this.v;
      const f = this.frame;
      const db = dbfs(this._samples, at - this._base, at - this._base + f);
      // 100 ms level for the floor (mean energy of the last frames).
      this._smooth.push(Math.pow(10, db / 10));
      const nSmooth = Math.max(1, Math.round(v.FLOOR_SMOOTH_S / v.FRAME_S));
      if (this._smooth.length > nSmooth) this._smooth.shift();
      if (this._smooth.length === nSmooth) {
        let e = 0;
        for (const x of this._smooth) e += x;
        const level = Math.max(v.MIN_FLOOR_DBFS, 10 * Math.log10(e / nSmooth + 1e-12));
        this._floorHist.push(level);
        const nHist = Math.round(v.FLOOR_WINDOW_S / v.FRAME_S);
        if (this._floorHist.length > nHist) this._floorHist.shift();
        let min = Infinity;
        for (const x of this._floorHist) if (x < min) min = x;
        // Down at once, up at most FLOOR_RISE_DB_PER_S: a long stretch of speech without
        // a real gap does not become the floor.
        this.floor = this.floor === null ? min : Math.min(min, this.floor + v.FLOOR_RISE_DB_PER_S * v.FRAME_S);
      }
      const floor = this.floor === null ? Math.max(v.MIN_FLOOR_DBFS, db) : this.floor;
      const speech = db > floor + v.SPEECH_DB && db > v.MIN_SPEECH_DBFS;
      this._frames.push({ db, speech });
      const end = at + f;
      const frameS = f / this.rate;
      let r = this._region;
      if (speech) {
        if (!r) {
          r = this._region = { start: at, lastSpeechEnd: end, speechFrames: 0 };
          this._lookBack(r, floor);
        }
        r.speechFrames++;
        r.lastSpeechEnd = end;
        this._silence = 0;
      } else if (r) {
        this._silence++;
        const silenceS = this._silence * frameS;
        const speechS = r.speechFrames * frameS;
        if (speechS >= v.MIN_SPEECH_S && silenceS >= this._endSilence(r, end, speechS)) {
          const pad = Math.round(v.PAD_S * this.rate);
          const from = Math.max(this.consumed, r.start - pad);
          const to = Math.min(this._total, r.lastSpeechEnd + pad);
          out.push(this._emit(from, to, speechS, false));
          this.consumed = to;
          this._region = null;
          r = null;
        } else if (speechS < v.CLICK_S && silenceS >= v.DROP_SILENCE_S) {
          this._region = null; // a click or a knock: no word is that short
          r = null;
        }
      }
      if (r && (end - Math.max(this.consumed, r.start)) / this.rate >= v.MAX_PHRASE_S) {
        this._forcedCut(end, out);
      }
    }

    /**
     * The silence that ends the phrase: END_SILENCE_S, shrinking to SHORT_END_SILENCE_S
     * as the phrase's speech grows from LONG_SPEECH_S to LONGER_SPEECH_S, but only while
     * the phrase is dense speech (at least DENSE_SPEECH of its time since it started, the
     * silence now included) - a fluent reader. A word-by-word reader (much of the time
     * between words) keeps END_SILENCE_S.
     */
    _endSilence(r, end, speechS) {
      const v = this.v;
      if (speechS <= v.LONG_SPEECH_S) return v.END_SILENCE_S;
      const spanS = (end - r.start) / this.rate;
      if (speechS < v.DENSE_SPEECH * spanS) return v.END_SILENCE_S;
      const k = Math.min(1, (speechS - v.LONG_SPEECH_S) / Math.max(1e-6, v.LONGER_SPEECH_S - v.LONG_SPEECH_S));
      return v.END_SILENCE_S - k * (v.END_SILENCE_S - v.SHORT_END_SILENCE_S);
    }

    /**
     * A new region also takes the loud frames just before it that were heard before the
     * floor was known (speech from the very first moment of a recording), back to the
     * last phrase and at most TAIL_LEAD_S, across gaps shorter than 0.3 s.
     */
    _lookBack(r, floor) {
      const v = this.v;
      const f = this.frame;
      const limit = Math.max(this.consumed, r.start - Math.round(v.TAIL_LEAD_S * this.rate), this._frameBase * f);
      const maxGap = Math.round(0.3 / v.FRAME_S);
      let gap = 0;
      for (let k = r.start / f - 1; k * f >= limit && k >= this._frameBase; k--) {
        const fr = this._frames[k - this._frameBase];
        if (fr.db > floor + v.SPEECH_DB && fr.db > v.MIN_SPEECH_DBFS) {
          r.start = k * f;
          r.speechFrames++;
          fr.speech = true;
          gap = 0;
        } else if (++gap > maxGap) {
          break;
        }
      }
    }

    /** Cut in the longest pause of the last CUT_SEARCH_S (see VAD); the region goes on from there. */
    _forcedCut(end, out) {
      const v = this.v;
      const f = this.frame;
      const r = this._region;
      const startFrame = Math.ceil(Math.max(this.consumed, r.start, end - Math.round(v.CUT_SEARCH_S * this.rate)) / f);
      const endFrame = end / f - Math.round(0.5 / v.FRAME_S); // not in the last 0.5 s
      let best = endFrame;
      // The longest pause (run of frames that are not speech) in the window, at its middle:
      // the gap between two sentences or two words, rather than a quiet sound inside a
      // word. Equal runs: the quieter one.
      let bestLen = 0;
      let bestE = Infinity;
      for (let k = startFrame; k < endFrame; ) {
        if (this._frames[k - this._frameBase].speech) {
          k++;
          continue;
        }
        let j = k;
        let e = 0;
        while (j < endFrame && !this._frames[j - this._frameBase].speech) e += Math.pow(10, this._frames[j++ - this._frameBase].db / 10);
        const len = j - k;
        if (len > bestLen || (len === bestLen && e / len < bestE)) {
          bestLen = len;
          bestE = e / len;
          best = k + Math.floor(len / 2);
        }
        k = j;
      }
      if (bestLen < Math.round(0.1 / v.FRAME_S)) {
        // No pause of 100 ms: the quietest 100 ms.
        const win = Math.max(1, Math.round(0.1 / v.FRAME_S));
        bestE = Infinity;
        for (let k = startFrame; k + win <= endFrame; k++) {
          let e = 0;
          for (let j = k; j < k + win; j++) e += Math.pow(10, this._frames[j - this._frameBase].db / 10);
          if (e < bestE) {
            bestE = e;
            best = k + Math.floor(win / 2);
          }
        }
      }
      const cut = best * f;
      const pad = Math.round(v.PAD_S * this.rate);
      const from = Math.max(this.consumed, r.start - pad);
      let before = 0;
      let after = 0;
      for (let k = Math.floor(from / f); k < end / f; k++) {
        const fr = this._frames[k - this._frameBase];
        if (fr && fr.speech) {
          if (k < best) before++;
          else after++;
        }
      }
      out.push(this._emit(from, cut, (before * f) / this.rate, true));
      this.consumed = cut;
      // What follows the cut is a new region (it may be silence for now).
      if (after > 0) {
        r.start = cut;
        r.speechFrames = after;
      } else {
        this._region = null;
      }
    }

    _emit(from, to, speech, forced) {
      this.phrases++;
      return { samples: this._slice(from, to), start: from / this.rate, end: to / this.rate, speech, forced };
    }

    /** Drop the samples and frames no phrase or tail can need any more. */
    _trim() {
      const v = this.v;
      const f = this.frame;
      const lead = Math.round(Math.max(v.TAIL_LEAD_S, v.PAD_S) * this.rate);
      // A region needs its lead-in; the next one, the last `lead` of the signal.
      const keep = Math.max(this.consumed, (this._region ? this._region.start : this._total) - lead);
      const dropS = Math.min(keep - this._base, this._samples.length);
      if (dropS > 0) {
        this._samples = this._samples.slice(dropS);
        this._base += dropS;
      }
      const keepFrame = Math.floor(this._base / f);
      const dropF = Math.min(keepFrame - this._frameBase, this._frames.length);
      if (dropF > 0) {
        this._frames.splice(0, dropF);
        this._frameBase += dropF;
      }
    }
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
     *          onLimit?: () => void, onPhrase?: (phrase:object) => void,
     *          phraseOptions?: object}} [options] phraseOptions: PhraseSegmenter options
     *          (phraseOptionsFor(lang)).
     */
    constructor(options) {
      const opts = options || {};
      const max = Number(opts.maxSeconds) || MAX_SECONDS;
      this.maxSeconds = Math.max(1, Math.min(MAX_SECONDS, max));
      this.onLevel = typeof opts.onLevel === 'function' ? opts.onLevel : null;
      this.onLimit = typeof opts.onLimit === 'function' ? opts.onLimit : null;
      this.onPhrase = typeof opts.onPhrase === 'function' ? opts.onPhrase : null;
      this.phraseOptions = opts.phraseOptions && typeof opts.phraseOptions === 'object' ? opts.phraseOptions : {};
      this._resampler = null;
      this._segmenter = null;
      /** After stop(), with onPhrase: the rest after the last phrase (see the header). */
      this.tail = null;
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
        if (this.onPhrase) {
          this._resampler = new StreamResampler(ctx.sampleRate, TARGET_RATE);
          this._segmenter = new PhraseSegmenter(Object.assign({}, this.phraseOptions, { rate: TARGET_RATE }));
        }
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
        if (this._segmenter) {
          let phrases = [];
          try {
            phrases = this._segmenter.push(this._resampler.push(piece));
          } catch (e) {
            this._segmenter = null; // live phrases stop; the whole recording is still made
          }
          for (const phrase of phrases) {
            try {
              this.onPhrase(phrase);
            } catch (e) {
              /* a listener error must not stop the recording */
            }
          }
        }
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
      if (this._segmenter) {
        // What the last frames ended is part of the tail: nothing is emitted after stop().
        try {
          const late = this._segmenter.push(this._resampler.flush());
          const rest = this._segmenter.finish();
          if (late.length) {
            const speech = late.reduce((a, p) => a + p.speech, 0) + rest.speech;
            this.tail = { samples: concatSamples(late.map((p) => p.samples).concat([rest.samples])), start: late[0].start, end: rest.end, speech };
          } else {
            this.tail = rest;
          }
        } catch (e) {
          this.tail = null;
        }
        this._segmenter = null;
        this._resampler = null;
      }
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
      this._segmenter = null;
      this._resampler = null;
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
    concatSamples,
    StreamResampler,
    PhraseSegmenter,
    phraseOptionsFor,
    VAD,
    /** Number of microphone streams currently held by recorders (for tests). */
    openStreams: () => openStreams,
  };
});
