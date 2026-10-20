// #48: offline effect rendering. Per (take, effect): the dry voice (just the audible part,
// `offsetMs … offsetMs + durationMs`) goes through the recipe in an OfflineAudioContext, reverb
// sends are convolved in a second, lower-rate pass, then a loudness match + brickwall limiter.
// The result is a plain AudioBuffer that DubPlayer schedules like any take, with `leadMs`
// before and `tailMs` after the dry span.
import type { FxEffectId } from '@dub/shared';
import workletUrl from './pitch-shifter.worklet.js?url';
import { finalize, hashString, rms, type IrKind } from './dsp';
import { Graph, type FxTiming } from './graph';
import { FX_REGISTRY, MAX_LEAD_SEC, MAX_SENDS, MAX_TAIL_SEC, type FxDef } from './registry';

export interface FxSource {
  /** Decoded take (any channel count; mixed to mono). */
  buffer: AudioBuffer;
  offsetMs: number;
  durationMs: number;
  /** Seeds the effect's randomness (bubbles, noise): same take → same render. */
  seed: string;
}

export interface ProcessedAudio {
  fx: FxEffectId;
  buffer: AudioBuffer;
  /** Audio before the dry start (ghost swell), ms. Buffer time 0 = dry start − leadMs. */
  leadMs: number;
  /** Ring-out after the dry end, ms (≤ 2000). */
  tailMs: number;
  renderMs: number;
  /** AudioWorklet was used (false: the JS fallback). */
  worklet: boolean;
}

/** Sample rate of the reverb pass (and the ghost swell). */
export const REVERB_SAMPLE_RATE = 24_000;

const FADE_SEC = 0.004;

let workletOk: boolean | null = null;

/** Loads the DSP worklet into `ctx`. False when AudioWorklet is missing or failed once. */
async function loadWorklet(ctx: BaseAudioContext): Promise<boolean> {
  if (workletOk === false || typeof AudioWorkletNode === 'undefined' || !ctx.audioWorklet)
    return false;
  try {
    await ctx.audioWorklet.addModule(workletUrl);
    workletOk = true;
    return true;
  } catch (e) {
    console.warn('[fx] AudioWorklet unavailable, using the JS fallback', e);
    workletOk = false;
    return false;
  }
}

/** Test hook: force (false) or allow (true) the no-worklet path. */
export function setWorkletAllowed(on: boolean): void {
  workletOk = on ? null : false;
}

/** The dry voice as mono, with `lead` s of silence before and `tail` s after, short fades. */
function placeDry(src: FxSource, sr: number, lead: number, tail: number) {
  const b = src.buffer;
  const off = Math.round((src.offsetMs / 1000) * b.sampleRate);
  const len = Math.max(
    1,
    Math.min(b.length - off, Math.round((src.durationMs / 1000) * b.sampleRate)),
  );
  const leadN = Math.round(lead * sr);
  const total = leadN + len + Math.round(tail * sr);
  const out = new Float32Array(total);
  const chans = Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));
  const k = 1 / chans.length;
  const fade = Math.max(1, Math.round(FADE_SEC * sr));
  for (let i = 0; i < len; i++) {
    let v = 0;
    for (const ch of chans) v += ch[off + i] ?? 0;
    let f = 1;
    if (i < fade) f = i / fade;
    else if (i >= len - fade) f = (len - i) / fade;
    out[leadN + i] = v * k * f;
  }
  const buf = new AudioBuffer({ length: total, numberOfChannels: 1, sampleRate: sr });
  buf.copyToChannel(out, 0);
  return { buf, from: leadN, to: leadN + len };
}

function reverse(b: AudioBuffer): AudioBuffer {
  const out = new AudioBuffer({
    length: b.length,
    numberOfChannels: b.numberOfChannels,
    sampleRate: b.sampleRate,
  });
  for (let c = 0; c < b.numberOfChannels; c++)
    out.copyToChannel(b.getChannelData(c).slice().reverse(), c);
  return out;
}

const NO_TIME: FxTiming = { lead: 0, dur: 0, end: 0, total: 0 };

/**
 * Ghost's reverse-reverb swell: reverse the voice, convolve with a bright hall, reverse back.
 * Every word then has a swell that grows *into* it from up to 1.2 s before (the lead).
 * Rendered at REVERB_SAMPLE_RATE; the main pass resamples it when it plays the buffer.
 */
async function reverseSwell(dry: AudioBuffer, seed: number): Promise<AudioBuffer> {
  const sr = REVERB_SAMPLE_RATE;
  const ctx = new OfflineAudioContext(2, Math.ceil((dry.length * sr) / dry.sampleRate), sr);
  const g = new Graph(ctx, NO_TIME, dry, false, seed);
  g.chain(g.bufferNode(reverse(dry)), g.convolver('swell', 2), ctx.destination);
  const out = await ctx.startRendering();
  g.dispose();
  return reverse(out);
}

/**
 * Second pass: each reverb send (an extra channel of the first pass) through its impulse
 * response at REVERB_SAMPLE_RATE, added onto the output channels with linear interpolation
 * back up (the IRs are dark; the interpolation images are far below the dry signal).
 * ConvolverNode at 48 kHz with a 2 s stereo IR cost Chromium ~1 s per 7 s take; this ~¼.
 */
async function renderSends(
  out: Float32Array[],
  sends: { data: Float32Array; kind: IrKind }[],
  sr: number,
  seed: number,
) {
  const rsr = REVERB_SAMPLE_RATE;
  const n = out[0]!.length;
  const ctx = new OfflineAudioContext(out.length, Math.ceil((n * rsr) / sr) + 1, rsr);
  const g = new Graph(ctx, NO_TIME, null as unknown as AudioBuffer, false, seed);
  for (const s of sends) {
    const b = new AudioBuffer({ length: n, numberOfChannels: 1, sampleRate: sr });
    b.copyToChannel(s.data as Float32Array<ArrayBuffer>, 0);
    g.chain(g.bufferNode(b), g.convolver(s.kind, out.length), ctx.destination);
  }
  const wet = await ctx.startRendering();
  g.dispose();
  const k = rsr / sr;
  for (let c = 0; c < out.length; c++) {
    const w = wet.getChannelData(c);
    const o = out[c]!;
    for (let i = 0; i < n; i++) {
      const x = i * k;
      const j = Math.floor(x);
      const f = x - j;
      o[i]! += (w[j] ?? 0) * (1 - f) + (w[j + 1] ?? 0) * f;
    }
  }
}

export function fxTiming(def: Pick<FxDef, 'leadSec' | 'tailSec'>, durationMs: number): FxTiming {
  const lead = Math.min(MAX_LEAD_SEC, def.leadSec);
  const dur = durationMs / 1000;
  const tail = Math.min(MAX_TAIL_SEC, def.tailSec);
  return { lead, dur, end: lead + dur, total: lead + dur + tail };
}

/** Renders `src` through effect `fx`. */
export async function renderFx(src: FxSource, fx: FxEffectId): Promise<ProcessedAudio> {
  const t0 = performance.now();
  const def = FX_REGISTRY[fx];
  const sr = src.buffer.sampleRate;
  const t = fxTiming(def, src.durationMs);
  const { buf: dry, from, to } = placeDry(src, sr, t.lead, t.total - t.end);
  t.dur = (to - from) / sr;
  t.end = t.lead + t.dur;
  t.total = dry.length / sr;
  const seed = hashString(`${src.seed}:${fx}`);

  const swell = def.reverseSwell ? await reverseSwell(dry, seed) : null;
  // Destination channels: the effect's output, then one mono channel per reverb send.
  const C = def.channels;
  const ctx = new OfflineAudioContext(C + MAX_SENDS, dry.length, sr);
  ctx.destination.channelInterpretation = 'discrete';
  const worklet = await loadWorklet(ctx);
  const g = new Graph(ctx, t, dry, worklet, seed);
  const input = g.bufferNode(dry);
  const out = g.gain(1);
  out.channelCount = C;
  out.channelCountMode = 'explicit';
  out.channelInterpretation = 'speakers'; // mono → both sides
  const merge = g.track(ctx.createChannelMerger(C + MAX_SENDS));
  const split = g.track(ctx.createChannelSplitter(C));
  out.connect(split);
  for (let c = 0; c < C; c++) split.connect(merge, c, c);
  merge.connect(ctx.destination);
  const built = def.build(ctx, input, out, g);
  if (swell) g.chain(g.bufferNode(swell), g.filter('highpass', 300), g.gain(0.9), out);
  if (g.sends.length > MAX_SENDS) throw new Error(`${fx}: too many reverb sends`);
  g.sends.forEach((s, k) => {
    const mono = g.gain(1);
    mono.channelCount = 1;
    mono.channelCountMode = 'explicit';
    s.node.connect(mono);
    mono.connect(merge, 0, C + k);
  });
  const sends = g.sends.map((s) => s.kind);
  const first = await ctx.startRendering();
  built.dispose();
  g.dispose();

  const chans = Array.from({ length: C }, (_, c) => first.getChannelData(c));
  if (sends.length > 0)
    await renderSends(
      chans,
      sends.map((kind, k) => ({ kind, data: first.getChannelData(C + k) })),
      sr,
      seed,
    );
  finalize(chans, {
    sampleRate: sr,
    targetRms: rms(dry.getChannelData(0), from, to) * (def.loudness ?? 1),
    measureFrom: from,
    measureTo: to,
    fadeOutSec: Math.min(0.3, Math.max(0.005, (t.total - t.end) * 0.5)),
  });
  const buffer = new AudioBuffer({ length: dry.length, numberOfChannels: C, sampleRate: sr });
  chans.forEach((c, i) => buffer.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  return {
    fx,
    buffer,
    leadMs: t.lead * 1000,
    tailMs: (t.total - t.end) * 1000,
    renderMs: performance.now() - t0,
    worklet,
  };
}
