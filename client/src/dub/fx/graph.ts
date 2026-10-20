// #48: a tiny node-graph builder for effect recipes. Tracks every node it creates so a
// recipe's `dispose()` is one call, and hides the AudioWorklet/fallback split for the two
// DSP blocks WebAudio lacks (granular pitch shift, sample-and-hold crusher).
import { GranularShifter } from './pitch-shifter.worklet.js';
import { makeImpulse, quantizeCurve, seededRng, whiteNoise, crackle, type IrKind } from './dsp';

export interface FxTiming {
  /** Seconds of (silent) lead before the voice starts in the render (ghost swell). */
  lead: number;
  /** Dry voice length (s). */
  dur: number;
  /** Render length incl. lead and tail (s). */
  total: number;
  /** `lead + dur`: when the voice ends. */
  end: number;
}

export interface Disposable {
  dispose(): void;
}

const irCache = new Map<string, AudioBuffer>();

function toBuffer(channels: Float32Array[], sampleRate: number): AudioBuffer {
  const b = new AudioBuffer({
    length: channels[0]!.length,
    numberOfChannels: channels.length,
    sampleRate,
  });
  channels.forEach((c, i) => b.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  return b;
}

export class Graph implements Disposable {
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  /** Reverb sends collected by `reverb()`, rendered in the second pass. */
  readonly sends: { node: GainNode; kind: IrKind }[] = [];
  readonly rng: () => number;

  constructor(
    readonly ctx: BaseAudioContext,
    readonly t: FxTiming,
    /** The dry voice (mono, already placed at `t.lead`), for the no-worklet pitch fallback. */
    private readonly dry: AudioBuffer,
    /** AudioWorklet module loaded into `ctx`. */
    readonly worklet: boolean,
    seed: number,
  ) {
    this.rng = seededRng(seed);
  }

  track<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  gain(v: number): GainNode {
    const g = this.track(this.ctx.createGain());
    g.gain.value = v;
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = 0.707, gainDb = 0): BiquadFilterNode {
    const f = this.track(this.ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.gain.value = gainDb;
    return f;
  }

  shaper(curve: Float32Array, oversample: OverSampleType = '2x'): WaveShaperNode {
    const w = this.track(this.ctx.createWaveShaper());
    w.curve = curve as Float32Array<ArrayBuffer>;
    w.oversample = oversample;
    return w;
  }

  delay(sec: number, max = Math.max(1, sec * 2)): DelayNode {
    const d = this.track(this.ctx.createDelay(max));
    d.delayTime.value = sec;
    return d;
  }

  compressor(
    o: Partial<Record<'threshold' | 'knee' | 'ratio' | 'attack' | 'release', number>>,
  ): DynamicsCompressorNode {
    const c = this.track(this.ctx.createDynamicsCompressor());
    if (o.threshold !== undefined) c.threshold.value = o.threshold;
    if (o.knee !== undefined) c.knee.value = o.knee;
    if (o.ratio !== undefined) c.ratio.value = o.ratio;
    if (o.attack !== undefined) c.attack.value = o.attack;
    if (o.release !== undefined) c.release.value = o.release;
    return c;
  }

  pan(v: number): StereoPannerNode {
    const p = this.track(this.ctx.createStereoPanner());
    p.pan.value = v;
    return p;
  }

  /**
   * Reverb send: `source × wet` through the `kind` impulse response, added to the output. The
   * convolution itself runs in a second pass at REVERB_SAMPLE_RATE (see render.ts):
   * ConvolverNode at 48 kHz with a 2 s stereo IR cost Chromium ~1 s per 7 s take, at 24 kHz a
   * quarter of that, and a reverb tail has no content up there worth paying for.
   */
  reverb(source: AudioNode, kind: IrKind, wet: number): void {
    const g = this.gain(wet);
    source.connect(g);
    this.sends.push({ node: g, kind });
  }

  /** A ConvolverNode with a procedural IR (cached per kind, rate and channel count). */
  convolver(kind: IrKind, channels = 2): ConvolverNode {
    const sr = this.ctx.sampleRate;
    const key = `${kind}@${sr}x${channels}`;
    let ir = irCache.get(key);
    if (!ir) irCache.set(key, (ir = toBuffer(makeImpulse(kind, sr, channels), sr)));
    const c = this.track(this.ctx.createConvolver());
    c.normalize = false;
    c.buffer = ir;
    return c;
  }

  osc(type: OscillatorType, freq: number, start = 0, stop = this.t.total): OscillatorNode {
    const o = this.track(this.ctx.createOscillator());
    o.type = type;
    o.frequency.value = freq;
    o.start(start);
    o.stop(stop);
    this.sources.push(o);
    return o;
  }

  /** `depth × sin(2π·freq·t)` into `param` (adds to its value). */
  lfo(param: AudioParam, freq: number, depth: number, type: OscillatorType = 'sine'): void {
    const o = this.osc(type, freq);
    o.connect(this.gainInto(depth, param));
  }

  private gainInto(v: number, param: AudioParam): GainNode {
    const g = this.gain(v);
    g.connect(param);
    return g;
  }

  /** Plays `data` (mono) from `when`. */
  buffer(data: Float32Array, when = 0): AudioBufferSourceNode {
    const s = this.track(this.ctx.createBufferSource());
    s.buffer = toBuffer([data], this.ctx.sampleRate);
    s.start(when);
    this.sources.push(s);
    return s;
  }

  bufferNode(b: AudioBuffer, when = 0): AudioBufferSourceNode {
    const s = this.track(this.ctx.createBufferSource());
    s.buffer = b;
    s.start(when);
    this.sources.push(s);
    return s;
  }

  /** White noise from `from` for `sec` seconds, with 10 ms fades. */
  noise(from: number, sec: number, amp = 1): AudioBufferSourceNode {
    const sr = this.ctx.sampleRate;
    const n = Math.max(1, Math.round(sec * sr));
    const d = whiteNoise(n, this.rng, amp);
    const f = Math.min(n >> 1, Math.round(0.01 * sr));
    for (let i = 0; i < f; i++) {
      d[i]! *= i / f;
      d[n - 1 - i]! *= i / f;
    }
    return this.buffer(d, from);
  }

  crackle(from: number, sec: number, perSec?: number): AudioBufferSourceNode {
    const sr = this.ctx.sampleRate;
    return this.buffer(crackle(Math.max(1, Math.round(sec * sr)), sr, this.rng, perSec), from);
  }

  /**
   * `input` pitch-shifted by `semitones`, optionally wobbling ±`mod.depth` semitones at
   * `mod.freq` Hz. AudioWorklet when available; otherwise the same granular core runs here on
   * the dry voice (constant shift, no wobble) and plays as a buffer.
   */
  pitched(
    input: AudioNode,
    semitones: number,
    mod?: { freq: number; depth: number },
    windowSec = 0.05,
  ): AudioNode {
    if (this.worklet) {
      const n = this.track(
        new AudioWorkletNode(this.ctx, 'vj-pitch', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: 'explicit',
          processorOptions: { windowSec },
        }),
      );
      const p = n.parameters.get('semitones')!;
      p.value = semitones;
      if (mod) this.lfo(p, mod.freq, mod.depth);
      input.connect(n);
      return n;
    }
    const src = this.dry.getChannelData(0);
    const out = new Float32Array(src.length);
    const core = new GranularShifter(this.ctx.sampleRate, windowSec);
    for (let i = 0; i < src.length; i += 128) {
      const end = Math.min(src.length, i + 128);
      core.process(src.subarray(i, end), out.subarray(i, end), semitones);
    }
    return this.buffer(out, 0);
  }

  /** Bit depth + sample-rate reduction; without AudioWorklet only the bit depth (waveshaper). */
  crush(bits: number, hold: number): { input: AudioNode; output: AudioNode } {
    if (this.worklet) {
      const n = this.track(
        new AudioWorkletNode(this.ctx, 'vj-crush', {
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: 'explicit',
        }),
      );
      n.parameters.get('bits')!.value = bits;
      n.parameters.get('hold')!.value = hold;
      return { input: n, output: n };
    }
    const w = this.shaper(quantizeCurve(bits), 'none');
    return { input: w, output: w };
  }

  /** Connects a → b → c …, returns the last node. */
  chain(...nodes: (AudioNode | { input: AudioNode; output: AudioNode })[]): AudioNode {
    let prev: AudioNode | null = null;
    for (const x of nodes) {
      const [inp, out] =
        'input' in x && 'output' in x ? [x.input, x.output] : [x as AudioNode, x as AudioNode];
      prev?.connect(inp);
      prev = out;
    }
    return prev!;
  }

  dispose(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* not started / already stopped */
      }
    }
    for (const n of this.nodes) n.disconnect();
    this.nodes.length = 0;
    this.sources.length = 0;
  }
}
