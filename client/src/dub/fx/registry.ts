// #48 voice effects: the recipes. Each `build` wires `input` (the dry voice, mono, placed at
// `t.lead` in the render) to `output` inside an OfflineAudioContext. Every effect here is
// `offline: true`: it is rendered once per (chunk, effect) and DubPlayer just plays the result,
// so playback costs the same as a dry take, modulated effects included (they are
// deterministic given the take, so a render is as good as a live graph).
import { FX_IDS, FX_INFO, type FxEffectId } from '@dub/shared';
import { hardClipCurve, softClipCurve } from './dsp';
import { Graph, type Disposable } from './graph';

export interface FxDef {
  id: FxEffectId;
  emoji: string;
  name: string;
  /** Pre-renderable (static given the take). All built-ins are. */
  offline: true;
  channels: 1 | 2;
  /** Audio the effect adds before the voice (reverse swell), s. */
  leadSec: number;
  /** Ring-out after the voice (reverb/echo/squelch), s. ≤ MAX_TAIL_SEC. */
  tailSec: number;
  /** Ghost: also needs the reverse-reverb swell of the take (rendered in a pre-pass). */
  reverseSwell?: boolean;
  /** Loudness relative to the dry take after the match (1 = same RMS). */
  loudness?: number;
  build(ctx: BaseAudioContext, input: AudioNode, output: AudioNode, g: Graph): Disposable;
}

export const MAX_TAIL_SEC = 2;
/** Reverb sends per recipe (extra channels of the first render pass). */
export const MAX_SENDS = 2;
export const MAX_LEAD_SEC = 1.2;

type Recipe = Omit<FxDef, 'id' | 'emoji' | 'name' | 'offline'>;

/** HP + LP band (two biquads each side for a steeper, "small speaker" band). */
function band(
  g: Graph,
  lo: number,
  hi: number,
  steep = true,
): { input: AudioNode; output: AudioNode } {
  const a = g.filter('highpass', lo);
  const parts: AudioNode[] = [a];
  if (steep) parts.push(g.filter('highpass', lo));
  parts.push(g.filter('lowpass', hi));
  if (steep) parts.push(g.filter('lowpass', hi));
  return { input: a, output: g.chain(...parts) };
}

/** Feedback delay loop: input → [delay → filter → fb] (the loop), returns the delay output. */
function echoLoop(g: Graph, input: AudioNode, sec: number, fb: number, lpHz: number): AudioNode {
  const d = g.delay(sec);
  const lp = g.filter('lowpass', lpHz);
  const f = g.gain(fb);
  input.connect(d);
  d.connect(lp);
  lp.connect(f);
  f.connect(d);
  return lp;
}

const RECIPES: Record<FxEffectId, Recipe> = {
  // 🎤 band-limited, overdriven, crushed, pumping, hissy.
  trashmic: {
    channels: 1,
    leadSec: 0,
    tailSec: 0.1,
    build(_ctx, input, output, g) {
      const crush = g.crush(7, 2);
      const comp = g.compressor({
        threshold: -34,
        knee: 0,
        ratio: 14,
        attack: 0.002,
        release: 0.18,
      });
      g.chain(
        input,
        band(g, 400, 3000),
        g.gain(4),
        g.shaper(softClipCurve(3)),
        crush,
        comp,
        g.gain(2),
        output,
      );
      g.chain(
        g.noise(g.t.lead, g.t.dur + 0.08, 0.5),
        g.filter('highpass', 2500),
        g.gain(0.005),
        output,
      );
      return g;
    },
  },
  // 🤖 ring mod at 50 Hz, metallic comb, a bit of crush.
  robot: {
    channels: 1,
    leadSec: 0,
    tailSec: 0.1,
    build(_ctx, input, output, g) {
      const ring = g.gain(0);
      g.osc('sine', 50).connect(ring.gain);
      input.connect(ring);
      const sum = g.gain(1);
      ring.connect(sum);
      const comb = echoLoop(g, ring, 0.0062, 0.62, 9000);
      comb.connect(sum);
      const dry = g.gain(0.18);
      input.connect(dry);
      dry.connect(sum);
      g.chain(sum, g.crush(8, 1), g.filter('highpass', 120), output);
      return g;
    },
  },
  // 🏔️ 320 ms feedback echo, each repeat darker.
  canyon: {
    channels: 1,
    leadSec: 0,
    tailSec: 2,
    build(_ctx, input, output, g) {
      input.connect(output);
      const pre = g.filter('highpass', 180);
      input.connect(pre);
      const wet = g.gain(0.7);
      echoLoop(g, pre, 0.32, 0.55, 2600).connect(wet);
      wet.connect(output);
      return g;
    },
  },
  // 🙌 four pitch-shifted voices spread in time and stereo, warm shelf, cathedral.
  gospel: {
    channels: 2,
    leadSec: 0,
    tailSec: 2,
    build(_ctx, input, output, g) {
      const warm = g.filter('lowshelf', 250, 0.707, 4);
      input.connect(warm);
      const bus = g.gain(1);
      const dry = g.gain(0.75);
      warm.connect(dry);
      dry.connect(bus);
      const voices: [number, number, number, number][] = [
        // semitones, delay s, pan, gain
        [-5, 0.018, -0.65, 0.42],
        [4, 0.031, 0.55, 0.42],
        [7, 0.012, -0.25, 0.36],
        [-12, 0.026, 0.8, 0.3],
      ];
      voices.forEach(([semi, d, p, v], i) => {
        const del = g.delay(d, 0.1);
        // Each voice drifts a little in time: chorus-like detune, no two singers in lockstep.
        g.lfo(del.delayTime, 0.27 + i * 0.11, 0.0025);
        g.chain(g.pitched(warm, semi), del, g.pan(p), g.gain(v), bus);
      });
      bus.connect(output);
      g.reverb(bus, 'cathedral', 0.5);
      return g;
    },
  },
  // 🎈 +7 semitones, airy top.
  helium: {
    channels: 1,
    leadSec: 0,
    tailSec: 0.05,
    build(_ctx, input, output, g) {
      g.chain(
        g.pitched(input, 7, undefined, 0.035),
        g.filter('highshelf', 2500, 0.707, 6),
        g.filter('peaking', 900, 1, -3),
        output,
      );
      return g;
    },
  },
  // 😈 −7 semitones, distortion, sub-octave, dark plate.
  demon: {
    channels: 2,
    leadSec: 0,
    tailSec: 1.2,
    build(_ctx, input, output, g) {
      const sum = g.gain(1);
      g.chain(
        g.pitched(input, -7),
        g.gain(3),
        g.shaper(softClipCurve(2.5)),
        g.filter('lowpass', 3200),
        sum,
      );
      g.chain(g.pitched(input, -12, undefined, 0.07), g.filter('lowpass', 500), g.gain(0.8), sum);
      const body = g.chain(sum, g.filter('lowshelf', 150, 0.707, 5));
      body.connect(output);
      g.reverb(body, 'darkPlate', 0.4);
      return g;
    },
  },
  // 📻 narrow band, saturated, wow & flutter, crackle and mains hum.
  radio: {
    channels: 1,
    leadSec: 0,
    tailSec: 0.1,
    build(_ctx, input, output, g) {
      const wow = g.delay(0.012, 0.05);
      g.lfo(wow.delayTime, 0.55, 0.0025);
      g.lfo(wow.delayTime, 6.5, 0.0003);
      g.chain(
        input,
        band(g, 300, 2500),
        g.gain(2),
        g.shaper(softClipCurve(1.6)),
        wow,
        g.filter('peaking', 1200, 1, 3),
        output,
      );
      const span = g.t.dur + 0.1;
      g.chain(g.crackle(g.t.lead, span), g.filter('highpass', 900), g.gain(0.35), output);
      g.chain(g.noise(g.t.lead, span, 0.5), g.filter('bandpass', 3000, 0.7), g.gain(0.012), output);
      const hum = g.gain(1);
      g.chain(g.osc('sine', 50, g.t.lead, g.t.end + 0.1), g.gain(0.012), hum);
      g.chain(g.osc('sine', 150, g.t.lead, g.t.end + 0.1), g.gain(0.005), hum);
      hum.connect(output);
      return g;
    },
  },
  // 📞 300–3400 Hz, presence bump, mild clip, 8 kHz sample-and-hold, line noise.
  phone: {
    channels: 1,
    leadSec: 0,
    tailSec: 0.05,
    build(ctx, input, output, g) {
      const hold = Math.max(1, Math.round(ctx.sampleRate / 8000));
      g.chain(
        input,
        band(g, 300, 3400),
        g.filter('peaking', 1700, 1, 5),
        g.gain(2.5),
        g.shaper(softClipCurve(1.2)),
        g.crush(12, hold),
        output,
      );
      g.chain(
        g.noise(g.t.lead, g.t.dur + 0.05, 0.5),
        band(g, 300, 3400, false),
        g.gain(0.01),
        output,
      );
      return g;
    },
  },
  // 📣 resonant mids, hard clip, short slap.
  megaphone: {
    channels: 1,
    leadSec: 0,
    tailSec: 0.35,
    build(_ctx, input, output, g) {
      const m = g.chain(
        input,
        g.filter('highpass', 500),
        g.filter('highpass', 500),
        g.filter('peaking', 1800, 1.2, 10),
        g.filter('lowpass', 4500),
        g.gain(8),
        g.shaper(hardClipCurve(0.5)),
        g.filter('lowpass', 5000),
        g.gain(0.9),
      );
      m.connect(output);
      g.reverb(m, 'slap', 0.45);
      return g;
    },
  },
  // 🐟 wobbling resonant lowpass, vibrato, tremolo, bubbles.
  underwater: {
    channels: 1,
    leadSec: 0,
    tailSec: 0.25,
    build(_ctx, input, output, g) {
      const vib = g.delay(0.008, 0.05);
      g.lfo(vib.delayTime, 4.5, 0.0015);
      const lp = g.filter('lowpass', 520, 7);
      g.lfo(lp.frequency, 0.6, 240);
      const trem = g.gain(0.75);
      g.lfo(trem.gain, 7, 0.25);
      g.chain(input, vib, lp, g.filter('lowpass', 900), g.gain(2), trem, output);
      // Bubbles: short rising sine blips.
      const bubbles = g.gain(1);
      const count = Math.round(g.t.dur * 4);
      for (let i = 0; i < count; i++) {
        const at = g.t.lead + g.rng() * (g.t.dur + 0.1);
        const f0 = 250 + g.rng() * 650;
        const len = 0.03 + g.rng() * 0.05;
        const o = g.osc('sine', f0, at, at + len + 0.01);
        o.frequency.setValueAtTime(f0, at);
        o.frequency.exponentialRampToValueAtTime(f0 * (2 + g.rng()), at + len);
        const env = g.gain(0);
        env.gain.setValueAtTime(0, at);
        env.gain.linearRampToValueAtTime(0.12 + g.rng() * 0.1, at + 0.005);
        env.gain.exponentialRampToValueAtTime(0.001, at + len);
        o.connect(env);
        env.connect(bubbles);
      }
      g.chain(bubbles, g.filter('lowpass', 1600), output);
      return g;
    },
  },
  // 👽 ring mod with a swept carrier, wobbling pitch, stereo ping-pong.
  alien: {
    channels: 2,
    leadSec: 0,
    tailSec: 1.2,
    build(ctx, input, output, g) {
      const ring = g.gain(0);
      const car = g.osc('sine', 420);
      g.lfo(car.frequency, 0.45, 280);
      car.connect(ring.gain);
      input.connect(ring);
      const sum = g.gain(1);
      g.chain(ring, g.gain(0.55), sum);
      g.chain(g.pitched(input, 4, { freq: 5, depth: 1.5 }), g.gain(0.6), sum);
      sum.connect(output);
      // Ping-pong: L ⇄ R cross-feedback.
      const dl = g.delay(0.19);
      const dr = g.delay(0.19);
      const merge = g.track(ctx.createChannelMerger(2));
      const wet = g.gain(0.5);
      g.chain(sum, wet, dl);
      g.chain(dl, g.gain(0.45), dr);
      g.chain(dr, g.gain(0.45), dl);
      dl.connect(merge, 0, 0);
      dr.connect(merge, 0, 1);
      merge.connect(output);
      return g;
    },
  },
  // 👻 reverse-reverb swell into the words, airy highpass, octave-up shimmer, hall.
  ghost: {
    channels: 2,
    leadSec: MAX_LEAD_SEC,
    tailSec: 1.6,
    reverseSwell: true,
    loudness: 0.9,
    build(_ctx, input, output, g) {
      const a = g.gain(1);
      g.chain(input, g.filter('highpass', 400), g.gain(0.6), a);
      g.chain(g.pitched(input, 12, undefined, 0.03), g.filter('highpass', 900), g.gain(0.3), a);
      a.connect(output);
      g.reverb(a, 'hall', 0.55);
      return g;
    },
  },
  // 🏟️ compressed, bright, slapback, big hall.
  stadium: {
    channels: 2,
    leadSec: 0,
    tailSec: 1.8,
    build(_ctx, input, output, g) {
      const s = g.chain(
        input,
        g.compressor({ threshold: -26, knee: 6, ratio: 5, attack: 0.005, release: 0.2 }),
        g.filter('highpass', 120),
        g.filter('highshelf', 4000, 0.707, 5),
        g.filter('peaking', 2500, 1, 3),
      );
      s.connect(output);
      g.chain(s, g.delay(0.11), g.gain(0.3), output);
      g.reverb(s, 'hall', 0.42);
      return g;
    },
  },
  // 🍺 slow pitch drift (modulated delay), time smear, a bit mumbly.
  tipsy: {
    channels: 1,
    leadSec: 0,
    tailSec: 0.2,
    build(_ctx, input, output, g) {
      const drift = g.delay(0.03, 0.1);
      g.lfo(drift.delayTime, 0.37, 0.012);
      g.lfo(drift.delayTime, 0.11, 0.008);
      const t = g.chain(input, drift, g.filter('lowpass', 3800));
      t.connect(output);
      g.chain(t, g.delay(0.045), g.filter('lowpass', 1800), g.gain(0.35), output);
      g.chain(t, g.delay(0.09), g.filter('lowpass', 1200), g.gain(0.2), output);
      return g;
    },
  },
  // 🎮 4-bit, ~8 kHz sample-and-hold, square-ish shaper.
  chiptune: {
    channels: 1,
    leadSec: 0,
    tailSec: 0.05,
    build(ctx, input, output, g) {
      const hold = Math.max(1, Math.round(ctx.sampleRate / 7000));
      g.chain(
        input,
        g.filter('highpass', 150),
        g.gain(2),
        g.crush(4, hold),
        g.shaper(softClipCurve(8), 'none'),
        g.gain(0.5),
        output,
      );
      return g;
    },
  },
  // 📟 narrow band, clipped, static, squelch "kssht" at both ends and a roger beep.
  walkie: {
    channels: 1,
    leadSec: 0,
    tailSec: 0.45,
    build(_ctx, input, output, g) {
      g.chain(
        input,
        band(g, 500, 2800),
        g.gain(5),
        g.shaper(hardClipCurve(0.6)),
        g.gain(0.8),
        output,
      );
      const { lead, end, dur } = g.t;
      g.chain(g.noise(lead, dur, 0.5), g.filter('bandpass', 2200, 0.7), g.gain(0.03), output);
      const squelch = (at: number, len: number, level: number) => {
        const env = g.gain(0);
        env.gain.setValueAtTime(0, at);
        env.gain.linearRampToValueAtTime(level, at + 0.006);
        env.gain.setValueAtTime(level, at + len * 0.6);
        env.gain.linearRampToValueAtTime(0, at + len);
        g.chain(
          g.noise(at, len + 0.02),
          g.filter('bandpass', 1800, 0.6),
          g.filter('highpass', 700),
          env,
          output,
        );
      };
      squelch(lead, 0.14, 0.45);
      const beep = g.gain(0);
      beep.gain.setValueAtTime(0, end);
      beep.gain.linearRampToValueAtTime(0.12, end + 0.005);
      beep.gain.setValueAtTime(0.12, end + 0.07);
      beep.gain.linearRampToValueAtTime(0, end + 0.08);
      g.chain(g.osc('square', 1300, end, end + 0.09), g.filter('lowpass', 2800), beep, output);
      squelch(end + 0.1, 0.25, 0.5);
      return g;
    },
  },
};

export const FX_REGISTRY: Readonly<Record<FxEffectId, FxDef>> = Object.fromEntries(
  FX_IDS.map((id) => [id, { id, ...FX_INFO[id], offline: true as const, ...RECIPES[id] }]),
) as Record<FxEffectId, FxDef>;

export const FX_LIST: readonly FxDef[] = FX_IDS.map((id) => FX_REGISTRY[id]);
