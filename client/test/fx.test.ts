import { FX_IDS, FX_INFO, type FxEffectId } from '@dub/shared';
import { describe, expect, it } from 'vitest';
import { FxCache } from '../src/dub/fx/cache';
import {
  audioHash,
  encodeWav,
  finalize,
  makeImpulse,
  peak,
  rms,
  seededRng,
  synthVoice,
  whiteNoise,
} from '../src/dub/fx/dsp';
import { dubChunkFor } from '../src/dub/fx/index';
import { Crusher, GranularShifter } from '../src/dub/fx/pitch-shifter.worklet.js';
import { FX_LIST, FX_REGISTRY, MAX_LEAD_SEC, MAX_TAIL_SEC } from '../src/dub/fx/registry';
import { fxTiming, type ProcessedAudio } from '../src/dub/fx/render';

const SR = 48_000;

/** Frequency of the strongest DFT bin between lo and hi Hz (1 Hz steps, Goertzel). */
function peakHz(x: Float32Array, lo: number, hi: number): number {
  let best = 0;
  let bestF = 0;
  const n = x.length;
  for (let f = lo; f <= hi; f += 1) {
    const w = (2 * Math.PI * f) / SR;
    const c = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const hannW = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      const s = x[i]! * hannW + c * s1 - s2;
      s2 = s1;
      s1 = s;
    }
    const p = s1 * s1 + s2 * s2 - c * s1 * s2;
    if (p > best) {
      best = p;
      bestF = f;
    }
  }
  return bestF;
}

function shift(x: Float32Array, semis: number): Float32Array {
  const out = new Float32Array(x.length);
  const core = new GranularShifter(SR, 0.05);
  for (let i = 0; i < x.length; i += 128)
    core.process(x.subarray(i, i + 128), out.subarray(i, i + 128), semis);
  return out;
}

describe('#48 fx registry', () => {
  it('one recipe per allow-listed id, emoji/name from the shared list, sane bounds', () => {
    expect(FX_LIST.map((d) => d.id)).toEqual([...FX_IDS]);
    for (const id of FX_IDS) {
      const d = FX_REGISTRY[id];
      expect(d.emoji).toBe(FX_INFO[id].emoji);
      expect(d.name).toBe(FX_INFO[id].name);
      expect(d.offline).toBe(true);
      expect(d.tailSec).toBeGreaterThanOrEqual(0);
      expect(d.tailSec).toBeLessThanOrEqual(MAX_TAIL_SEC);
      expect(d.leadSec).toBeLessThanOrEqual(MAX_LEAD_SEC);
      expect([1, 2]).toContain(d.channels);
      expect(typeof d.build).toBe('function');
    }
    expect(FX_REGISTRY.ghost.reverseSwell).toBe(true);
  });
  it('render length = lead + dry + tail, never more than 2 s of tail', () => {
    for (const d of FX_LIST) {
      const t = fxTiming(d, 5000);
      expect(t.end).toBeCloseTo(t.lead + 5, 9);
      expect(t.total - t.end).toBeLessThanOrEqual(MAX_TAIL_SEC);
    }
    expect(fxTiming({ leadSec: 0, tailSec: 9 }, 1000).total).toBe(1 + MAX_TAIL_SEC);
  });
});

describe('granular pitch shifter', () => {
  const sine = (hz: number, sec = 1) => {
    const x = new Float32Array(Math.round(SR * sec));
    for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / SR);
    return x;
  };
  it('440 Hz +7 semitones lands near 659 Hz', () => {
    const y = shift(sine(440), 7).subarray(4800, 4800 + 24000); // skip the first window
    expect(Math.abs(peakHz(y, 300, 1200) - 659.3)).toBeLessThan(6);
  });
  it('440 Hz −12 semitones lands near 220 Hz; 0 semitones stays at 440', () => {
    expect(
      Math.abs(peakHz(shift(sine(440), -12).subarray(4800, 4800 + 24000), 100, 800) - 220),
    ).toBeLessThan(4);
    expect(
      Math.abs(peakHz(shift(sine(440), 0).subarray(4800, 4800 + 24000), 100, 800) - 440),
    ).toBeLessThan(3);
  });
  it('keeps the level (crossfaded grains) and stays finite', () => {
    const y = shift(sine(300), 5).subarray(4800, 4800 + 24000);
    expect(rms(y)).toBeGreaterThan(0.2);
    expect(rms(y)).toBeLessThan(0.45);
    expect(peak([y])).toBeLessThan(0.8);
  });
});

describe('crusher', () => {
  it('quantises and holds samples', () => {
    const x = new Float32Array([0.1, 0.2, 0.3, 0.4, -0.6, -0.7]);
    const out = new Float32Array(6);
    new Crusher().process(x, out, 2, 2); // 2 levels per side, hold 2
    expect([...out]).toEqual([0, 0, 0.5, 0.5, -0.5, -0.5]);
  });
});

describe('dsp', () => {
  it('impulse responses: unit energy, decaying, finite, bounded length', () => {
    for (const kind of ['cathedral', 'hall', 'plate', 'darkPlate', 'slap', 'swell'] as const) {
      const ir = makeImpulse(kind, SR);
      expect(ir).toHaveLength(2);
      for (const ch of ir) {
        expect(ch.length).toBeLessThanOrEqual(2 * SR);
        let e = 0;
        for (const v of ch) e += v * v;
        expect(e).toBeCloseTo(1, 3);
        const q = ch.length >> 2;
        expect(rms(ch, 0, q)).toBeGreaterThan(rms(ch, 3 * q, ch.length) * 3);
      }
      expect(audioHash([ir[0]!])).not.toBe(audioHash([ir[1]!])); // decorrelated L/R
    }
  });
  it('finalize: scrubs NaN, matches loudness, limits peaks to the ceiling', () => {
    const rng = seededRng(1);
    const a = whiteNoise(SR, rng, 3); // way over 1
    a[100] = NaN;
    a[200] = Infinity;
    const b = a.slice();
    finalize([a, b], { sampleRate: SR, targetRms: 0.1, minGain: 0.01 });
    expect(peak([a, b])).toBeLessThanOrEqual(0.97);
    for (const v of a) expect(Number.isFinite(v)).toBe(true);
    expect(rms(a)).toBeGreaterThan(0.06);
    expect(rms(a)).toBeLessThan(0.12);
  });
  it('synth voice + wav encoder', () => {
    const v = synthVoice(SR, 1);
    expect(rms(v)).toBeGreaterThan(0.01);
    expect(peak([v])).toBeLessThan(1);
    const wav = encodeWav([v], SR);
    expect(wav.length).toBe(44 + SR * 2);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
  });
});

describe('FxCache', () => {
  const fakeBuffer = (len = 1000) =>
    ({
      length: len,
      numberOfChannels: 1,
      sampleRate: SR,
      duration: len / SR,
    }) as unknown as AudioBuffer;
  const setup = () => {
    const calls: FxEffectId[] = [];
    const cache = new FxCache({
      render: async (src, fx) => {
        calls.push(fx);
        return {
          fx,
          buffer: fakeBuffer(src.buffer.length),
          leadMs: 0,
          tailMs: 100,
          renderMs: 1,
          worklet: true,
        } satisfies ProcessedAudio;
      },
    });
    return { cache, calls };
  };
  const take = { id: 't1', offsetMs: 20, durationMs: 900 };

  it('dry takes are not rendered', () => {
    const { cache, calls } = setup();
    expect(cache.get(take, fakeBuffer())).toBeNull();
    expect(cache.get({ ...take, fx: 'none' }, fakeBuffer())).toBeNull();
    expect(calls).toEqual([]);
  });
  it('renders once per (chunk, fx); a changed fx renders again; switching back is a hit', async () => {
    const { cache, calls } = setup();
    const dry = fakeBuffer();
    const a = await cache.get({ ...take, fx: 'robot' }, dry)!;
    expect(await cache.get({ ...take, fx: 'robot' }, dry)!).toBe(a);
    expect(cache.peek({ ...take, fx: 'robot' }, dry)).toBe(a);
    expect(cache.peek({ ...take, fx: 'ghost' }, dry)).toBeNull(); // fx changed → not ready yet
    const b = await cache.get({ ...take, fx: 'ghost' }, dry)!;
    expect(b.fx).toBe('ghost');
    expect(await cache.get({ ...take, fx: 'robot' }, dry)!).toBe(a);
    expect(calls).toEqual(['robot', 'ghost']);
  });
  it('a new dry buffer or placement invalidates; drop() forgets a take', async () => {
    const { cache, calls } = setup();
    const dry = fakeBuffer();
    await cache.get({ ...take, fx: 'robot' }, dry);
    const dry2 = fakeBuffer();
    expect(cache.peek({ ...take, fx: 'robot' }, dry2)).toBeNull();
    await cache.get({ ...take, fx: 'robot' }, dry2);
    await cache.get({ ...take, durationMs: 800, fx: 'robot' }, dry2);
    expect(calls).toHaveLength(3);
    cache.drop('t1');
    expect(cache.size).toBe(0);
  });
  it('failed renders are not cached', async () => {
    let n = 0;
    const cache = new FxCache({
      render: async () => {
        n++;
        throw new Error('boom');
      },
    });
    await expect(cache.get({ ...take, fx: 'alien' }, fakeBuffer())!).rejects.toThrow('boom');
    await expect(cache.get({ ...take, fx: 'alien' }, fakeBuffer())!).rejects.toThrow('boom');
    expect(n).toBe(2);
  });
  it('evicts least recently used renders over the byte budget', async () => {
    const cache = new FxCache({
      maxBytes: 3 * 4000,
      render: async (src, fx) => ({
        fx,
        buffer: fakeBuffer(1000),
        leadMs: 0,
        tailMs: 0,
        renderMs: 0,
        worklet: true,
      }),
    });
    const dry = fakeBuffer();
    for (const id of ['a', 'b', 'c', 'd']) await cache.get({ ...take, id, fx: 'phone' }, dry);
    expect(cache.size).toBe(3);
    expect(cache.peek({ ...take, id: 'a', fx: 'phone' }, dry)).toBeNull();
  });
});

describe('dubChunkFor', () => {
  const dry = { length: 10 } as unknown as AudioBuffer;
  const proc = { length: 20 } as unknown as AudioBuffer;
  const meta = { id: 'x', startMs: 3000, offsetMs: 40, durationMs: 2000 };
  it('dry: the take as it is', () => {
    expect(dubChunkFor(meta, dry, null)).toEqual({ ...meta, buffer: dry });
  });
  it('processed: starts lead earlier, rings tail longer, offset into the render', () => {
    const p: ProcessedAudio = {
      fx: 'ghost',
      buffer: proc,
      leadMs: 1200,
      tailMs: 1600,
      renderMs: 0,
      worklet: true,
    };
    expect(dubChunkFor(meta, dry, p)).toEqual({
      id: 'x',
      startMs: 1800,
      offsetMs: 0,
      durationMs: 3200,
      tailMs: 1600,
      buffer: proc,
    });
    // Near the clip start the lead is clipped at 0.
    expect(dubChunkFor({ ...meta, startMs: 500 }, dry, p)).toMatchObject({
      startMs: 0,
      offsetMs: 700,
      durationMs: 2500,
    });
  });
});
