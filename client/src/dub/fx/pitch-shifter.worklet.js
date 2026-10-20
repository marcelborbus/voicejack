// #48 voice effects: the DSP that WebAudio has no node for. Loaded two ways:
//  - as an AudioWorklet module (`audioWorklet.addModule(url)`, url from `?url`), where it
//    registers the `vj-pitch` and `vj-crush` processors;
//  - as a plain ES module from TypeScript (fallback without AudioWorklet, unit tests), where
//    only the exported classes are used.
// Self-contained on purpose: a worklet module can't use the app's bundler imports.

/**
 * Granular (two-tap delay-line) pitch shifter. Two read heads sweep a delay line at
 * `ratio = 2^(semitones/12)` relative to the write head; each head's delay ramps through one
 * window, and the heads are half a window apart with sin² gains, which sum to 1, so the
 * splice points are crossfaded. Like a resampler per grain: formants move with the pitch,
 * which is exactly the chipmunk/demon sound we want.
 */
export class GranularShifter {
  /**
   * @param {number} sampleRate
   * @param {number} [windowSec] grain length (default 50 ms)
   */
  constructor(sampleRate, windowSec = 0.05) {
    this.win = Math.max(64, Math.round(sampleRate * windowSec));
    let size = 1;
    while (size < this.win * 2 + 8) size <<= 1;
    this.buf = new Float32Array(size);
    this.mask = size - 1;
    this.w = 0;
    this.phase = 0;
  }

  /**
   * @param {Float32Array | undefined} input  (missing = silence)
   * @param {Float32Array} output
   * @param {number} semitones
   */
  process(input, output, semitones) {
    const ratio = Math.pow(2, semitones / 12);
    const step = (1 - ratio) / this.win;
    const { buf, mask, win } = this;
    let w = this.w;
    let p = this.phase;
    const n = output.length;
    for (let i = 0; i < n; i++) {
      buf[w] = input ? input[i] : 0;
      let q = p + 0.5;
      if (q >= 1) q -= 1;
      // Two taps, linear interpolation, inlined (this loop runs per sample per voice).
      const pa = w - p * win;
      const ia = Math.floor(pa);
      const fa = pa - ia;
      const a0 = buf[ia & mask];
      const ya = a0 + (buf[(ia + 1) & mask] - a0) * fa;
      const pb = w - q * win;
      const ib = Math.floor(pb);
      const fb = pb - ib;
      const b0 = buf[ib & mask];
      const yb = b0 + (buf[(ib + 1) & mask] - b0) * fb;
      output[i] = ya * HANN[(p * HANN_N) | 0] + yb * HANN[(q * HANN_N) | 0];
      p += step;
      if (p >= 1) p -= 1;
      else if (p < 0) p += 1;
      w = (w + 1) & mask;
    }
    this.w = w;
    this.phase = p;
  }
}

/** sin²(πp) table: 0 at the splice, 1 mid-grain; hann(p) + hann(p + ½) = 1. */
const HANN_N = 2048;
const HANN = new Float32Array(HANN_N + 1);
for (let i = 0; i <= HANN_N; i++) {
  const s = Math.sin((Math.PI * i) / HANN_N);
  HANN[i] = s * s;
}

/** Bit-depth + sample-rate reduction (sample-and-hold), for the 8-bit / trashy mic sounds. */
export class Crusher {
  constructor() {
    this.held = 0;
    this.count = 0;
  }

  /**
   * @param {Float32Array | undefined} input
   * @param {Float32Array} output
   * @param {number} bits  amplitude resolution (≥ 1)
   * @param {number} hold  keep each sample this many samples (≥ 1)
   */
  process(input, output, bits, hold) {
    const levels = Math.pow(2, Math.max(1, bits)) / 2;
    const h = Math.max(1, Math.round(hold));
    for (let i = 0; i < output.length; i++) {
      if (this.count <= 0) {
        const x = input ? input[i] : 0;
        this.held = Math.round(x * levels) / levels;
        this.count = h;
      }
      this.count--;
      output[i] = this.held;
    }
  }
}

if (typeof registerProcessor === 'function') {
  class PitchProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        {
          name: 'semitones',
          defaultValue: 0,
          minValue: -24,
          maxValue: 24,
          automationRate: 'k-rate',
        },
      ];
    }
    constructor(options) {
      super();
      const o = (options && options.processorOptions) || {};
      this.core = new GranularShifter(sampleRate, o.windowSec || 0.05);
    }
    process(inputs, outputs, params) {
      const out = outputs[0];
      if (!out || !out[0]) return true;
      const inp = inputs[0] && inputs[0][0];
      this.core.process(inp, out[0], params.semitones[0]);
      for (let c = 1; c < out.length; c++) out[c].set(out[0]);
      return true;
    }
  }
  class CrushProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
      return [
        { name: 'bits', defaultValue: 8, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
        { name: 'hold', defaultValue: 1, minValue: 1, maxValue: 64, automationRate: 'k-rate' },
      ];
    }
    constructor() {
      super();
      this.core = new Crusher();
    }
    process(inputs, outputs, params) {
      const out = outputs[0];
      if (!out || !out[0]) return true;
      const inp = inputs[0] && inputs[0][0];
      this.core.process(inp, out[0], params.bits[0], params.hold[0]);
      for (let c = 1; c < out.length; c++) out[c].set(out[0]);
      return true;
    }
  }
  registerProcessor('vj-pitch', PitchProcessor);
  registerProcessor('vj-crush', CrushProcessor);
}
