// #48 voice effects: pure sample-level helpers (no WebAudio objects), so they unit-test in node.
// Procedural sources (noise, crackle, impulse responses), waveshaper curves, and the final
// loudness match + brickwall limiter every render goes through.

/** Small seeded PRNG (mulberry32): renders are deterministic per chunk. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string (seeds per chunk id). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function whiteNoise(n: number, rng: () => number, amp = 1): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rng() * 2 - 1) * amp;
  return out;
}

/** Vinyl crackle: sparse clicks of random size, each a few samples of decaying noise. */
export function crackle(
  n: number,
  sampleRate: number,
  rng: () => number,
  perSec = 18,
): Float32Array {
  const out = new Float32Array(n);
  const count = Math.round((n / sampleRate) * perSec);
  for (let k = 0; k < count; k++) {
    const at = Math.floor(rng() * n);
    const amp = (0.15 + 0.85 * rng() ** 3) * (rng() < 0.5 ? -1 : 1);
    const len = 4 + Math.floor(rng() * 40);
    for (let i = 0; i < len && at + i < n; i++)
      out[at + i]! += amp * Math.exp(-i / (len / 4)) * (rng() * 2 - 1);
  }
  return out;
}

export type IrKind = 'cathedral' | 'hall' | 'plate' | 'darkPlate' | 'slap' | 'swell';

interface IrSpec {
  seconds: number;
  /** Time to decay by 60 dB. */
  rt60: number;
  /** One-pole lowpass cutoff at the start / end of the tail: the tail darkens. */
  brightHz: number;
  darkHz: number;
  preDelay: number;
  /** Discrete early reflections [time s, gain]. */
  early?: [number, number][];
}

const IRS: Record<IrKind, IrSpec> = {
  cathedral: { seconds: 2, rt60: 3.2, brightHz: 6000, darkHz: 1200, preDelay: 0.03 },
  hall: {
    seconds: 1.6,
    rt60: 2.0,
    brightHz: 9000,
    darkHz: 2500,
    preDelay: 0.02,
    early: [
      [0.013, 0.5],
      [0.027, 0.35],
      [0.041, 0.25],
    ],
  },
  plate: { seconds: 1.1, rt60: 1.4, brightHz: 12000, darkHz: 5000, preDelay: 0.004 },
  darkPlate: { seconds: 1.1, rt60: 1.5, brightHz: 2400, darkHz: 700, preDelay: 0.006 },
  slap: {
    seconds: 0.3,
    rt60: 0.25,
    brightHz: 7000,
    darkHz: 3000,
    preDelay: 0,
    early: [
      [0, 1],
      [0.065, 0.55],
      [0.11, 0.35],
      [0.16, 0.2],
    ],
  },
  swell: { seconds: 1.2, rt60: 1.8, brightHz: 9000, darkHz: 4000, preDelay: 0 },
};

/**
 * Procedural impulse response: exponentially decaying noise (independent per channel for
 * width), lowpassed with a cutoff sweeping from `brightHz` to `darkHz`, plus early
 * reflections. Normalised to unit energy per channel so wet gains mean the same for every IR.
 */
export function makeImpulse(
  kind: IrKind,
  sampleRate: number,
  channels = 2,
  seed = 7,
): Float32Array[] {
  const spec = IRS[kind];
  const n = Math.max(1, Math.round(spec.seconds * sampleRate));
  const pre = Math.round(spec.preDelay * sampleRate);
  const k = 6.907755 / spec.rt60; // ln(1000): -60 dB at rt60
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const rng = seededRng(seed * 31 + c * 977 + kind.length);
    const ch = new Float32Array(n);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sampleRate;
      const frac = (i - pre) / Math.max(1, n - pre);
      const fc = spec.brightHz * Math.pow(spec.darkHz / spec.brightHz, frac);
      const a = 1 - Math.exp((-2 * Math.PI * fc) / sampleRate);
      lp += a * (rng() * 2 - 1 - lp);
      // Fade the last 10 % so the cut at `seconds` is not audible.
      const fade = frac > 0.9 ? (1 - frac) / 0.1 : 1;
      ch[i] = lp * Math.exp(-k * t) * fade;
    }
    for (const [t, g] of spec.early ?? []) {
      const i = pre + Math.round(t * sampleRate) + c * 7; // tiny L/R offset
      if (i < n) ch[i]! += g * (c === 0 ? 1 : 0.9) * 4;
    }
    let e = 0;
    for (let i = 0; i < n; i++) e += ch[i]! * ch[i]!;
    const g = e > 0 ? 1 / Math.sqrt(e) : 0;
    for (let i = 0; i < n; i++) ch[i]! *= g;
    out.push(ch);
  }
  return out;
}

// ---------- waveshaper curves (4096 points over -1..1) ----------

function curve(fn: (x: number) => number, n = 4096): Float32Array {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
  return c;
}

/** tanh saturation normalised to ±1 at the ends. */
export function softClipCurve(drive: number): Float32Array {
  const norm = Math.tanh(drive);
  return curve((x) => Math.tanh(drive * x) / norm);
}

export function hardClipCurve(threshold: number): Float32Array {
  return curve((x) => Math.max(-threshold, Math.min(threshold, x)) / threshold);
}

/** Amplitude quantisation (the crusher without sample-and-hold, used without AudioWorklet). */
export function quantizeCurve(bits: number): Float32Array {
  const levels = Math.pow(2, bits) / 2;
  return curve((x) => Math.round(x * levels) / levels, 8192);
}

// ---------- analysis + final stage ----------

export function rms(data: Float32Array, from = 0, to = data.length): number {
  let s = 0;
  const a = Math.max(0, from);
  const b = Math.min(data.length, to);
  for (let i = a; i < b; i++) s += data[i]! * data[i]!;
  return b > a ? Math.sqrt(s / (b - a)) : 0;
}

export function peak(channels: readonly Float32Array[]): number {
  let p = 0;
  for (const ch of channels)
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i]!);
      if (v > p) p = v;
    }
  return p;
}

/** Stable short hash of the audio (quantised to 16 bit), for tests and the debug hook. */
export function audioHash(channels: readonly Float32Array[]): string {
  let h = 0x811c9dc5;
  for (const ch of channels)
    for (let i = 0; i < ch.length; i += 7) {
      h ^= Math.round(ch[i]! * 32767) & 0xffff;
      h = Math.imul(h, 0x01000193);
    }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface FinalizeOptions {
  sampleRate: number;
  /** RMS the output should have (the dry take's), 0 = leave the level alone. */
  targetRms: number;
  /** Output RMS is measured over this sample range (where the voice is). */
  measureFrom?: number;
  measureTo?: number;
  ceiling?: number;
  /** Gain bounds for the loudness match. */
  minGain?: number;
  maxGain?: number;
  /** Fade-out over the last `fadeOutSec` (tail end). */
  fadeOutSec?: number;
}

/**
 * In place: NaN/Inf → 0, loudness match to `targetRms`, then a brickwall limiter (instant
 * attack over a 2 ms look-ahead window, ~80 ms release) so no sample exceeds `ceiling`,
 * and a short fade at the very end. Returns the applied makeup gain.
 */
export function finalize(channels: Float32Array[], o: FinalizeOptions): number {
  const ceiling = o.ceiling ?? 0.97;
  const n = channels[0]?.length ?? 0;
  for (const ch of channels) for (let i = 0; i < n; i++) if (!Number.isFinite(ch[i]!)) ch[i] = 0;

  let gain = 1;
  if (o.targetRms > 0) {
    let s = 0;
    for (const ch of channels) s += rms(ch, o.measureFrom ?? 0, o.measureTo ?? n) ** 2;
    const cur = Math.sqrt(s / Math.max(1, channels.length));
    if (cur > 1e-6) gain = Math.max(o.minGain ?? 0.25, Math.min(o.maxGain ?? 8, o.targetRms / cur));
  }

  // Needed gain per sample, spread back over the look-ahead window (only where it is < 1, so
  // this is cheap: after the loudness match few samples are over the ceiling).
  const look = Math.max(1, Math.round(o.sampleRate * 0.002));
  const rel = Math.exp(-1 / (o.sampleRate * 0.08));
  const need = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const ch of channels) {
      const v = Math.abs(ch[i]! * gain);
      if (v > m) m = v;
    }
    if (m > ceiling) {
      const r = ceiling / m;
      for (let j = Math.max(0, i - look + 1); j <= i; j++) if (r < need[j]!) need[j] = r;
    }
  }
  // Instant attack (the look-ahead already anticipates), exponential release.
  const g = need;
  let env = 1;
  for (let i = 0; i < n; i++) {
    const target = need[i]!;
    env = target < env ? target : target + (env - target) * rel;
    g[i] = env;
  }
  const fade = Math.min(n, Math.round((o.fadeOutSec ?? 0.03) * o.sampleRate));
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      let v = ch[i]! * gain * g[i]!;
      if (i >= n - fade) v *= (n - i) / fade;
      // Belt and braces: the envelope can lag a sample on rounding.
      ch[i] = v > ceiling ? ceiling : v < -ceiling ? -ceiling : v;
    }
  }
  return gain;
}

/**
 * A voice-like test signal: a gliding 110–170 Hz pulse train through two formant resonances,
 * in syllables (4 Hz on/off), with a pause. Used by the self-test and the spectrogram dumps.
 */
export function synthVoice(sampleRate: number, seconds: number): Float32Array {
  const n = Math.round(sampleRate * seconds);
  const out = new Float32Array(n);
  let ph = 0;
  // Two-pole resonators (formants ~700 Hz and ~1200 Hz).
  const res = (f: number, bw: number) => {
    const r = Math.exp((-Math.PI * bw) / sampleRate);
    return { a1: 2 * r * Math.cos((2 * Math.PI * f) / sampleRate), a2: -r * r, y1: 0, y2: 0 };
  };
  const f1 = res(700, 110);
  const f2 = res(1200, 140);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f0 = 140 + 30 * Math.sin(2 * Math.PI * 0.7 * t);
    ph += f0 / sampleRate;
    let x = 0;
    if (ph >= 1) {
      ph -= 1;
      x = 1;
    }
    const y1 = x + f1.a1 * f1.y1 + f1.a2 * f1.y2;
    f1.y2 = f1.y1;
    f1.y1 = y1;
    const y2 = x + f2.a1 * f2.y1 + f2.a2 * f2.y2;
    f2.y2 = f2.y1;
    f2.y1 = y2;
    const syll = Math.max(0, Math.sin(2 * Math.PI * 2 * t)) ** 0.5;
    const pause = t > seconds * 0.55 && t < seconds * 0.7 ? 0 : 1;
    out[i] = (y1 * 0.6 + y2 * 0.4) * 0.05 * syll * pause;
  }
  return out;
}

/** 16-bit PCM WAV of interleaved channels. */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  const n = channels[0]?.length ?? 0;
  const ch = channels.length;
  const data = n * ch * 2;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, data, true);
  let o = 44;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, channels[c]![i]!));
      v.setInt16(o, Math.round(s * 32767), true);
      o += 2;
    }
  return new Uint8Array(buf);
}
