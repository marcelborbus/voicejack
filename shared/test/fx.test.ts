import { describe, expect, it } from 'vitest';
import {
  C2SSchema,
  ChunkMetaSchema,
  FX_IDS,
  FX_INFO,
  FxIdSchema,
  LIMITS,
  fxEmojis,
  fxOf,
  isFxId,
  planSchedule,
  validateManifest,
  type ChunkMeta,
} from '../src/index.js';

const chunk: ChunkMeta = {
  id: 'take-1',
  startMs: 1000,
  offsetMs: 30,
  durationMs: 2000,
  mime: 'audio/webm;codecs=opus',
  bytes: 1000,
};

describe('#48 fx allow-list', () => {
  it('has 16 effects plus none, each with an emoji and a name', () => {
    expect(FX_IDS).toHaveLength(16);
    expect(new Set(FX_IDS).size).toBe(16);
    expect(Object.keys(FX_INFO).sort()).toEqual(['none', ...FX_IDS].sort());
    const emojis = Object.values(FX_INFO).map((i) => i.emoji);
    expect(new Set(emojis).size).toBe(emojis.length);
    for (const i of Object.values(FX_INFO)) expect(i.name.length).toBeGreaterThan(0);
  });
  it('isFxId / FxIdSchema accept exactly the list', () => {
    for (const id of ['none', ...FX_IDS]) {
      expect(isFxId(id)).toBe(true);
      expect(FxIdSchema.safeParse(id).success).toBe(true);
    }
    for (const bad of ['', 'ROBOT', 'reverb', '__proto__', 'constructor', 7, null]) {
      expect(isFxId(bad)).toBe(false);
      expect(FxIdSchema.safeParse(bad).success).toBe(false);
    }
  });
  it('ChunkMeta.fx is optional; unknown ids are rejected on the wire', () => {
    expect(ChunkMetaSchema.parse(chunk)).toEqual(chunk);
    expect(ChunkMetaSchema.parse({ ...chunk, fx: 'robot' }).fx).toBe('robot');
    expect(ChunkMetaSchema.safeParse({ ...chunk, fx: 'autotune' }).success).toBe(false);
    const msg = { t: 'manifest', round: 0, chunks: [{ ...chunk, fx: 'ghost' }] };
    expect(C2SSchema.parse(msg)).toEqual(msg);
    expect(C2SSchema.safeParse({ ...msg, chunks: [{ ...chunk, fx: '<script>' }] }).success).toBe(
      false,
    );
  });
  it('validateManifest rejects an unknown effect even without the schema', () => {
    const bad = { ...chunk, fx: 'nope' } as unknown as ChunkMeta;
    expect(validateManifest([bad], 20_000, LIMITS)).toEqual({
      ok: false,
      reason: 'chunk take-1 has an unknown effect',
    });
    expect(validateManifest([{ ...chunk, fx: 'helium' }], 20_000, LIMITS).ok).toBe(true);
  });
  it('fxOf / fxEmojis: absent = none, distinct emojis in first-use order', () => {
    expect(fxOf(chunk)).toBe('none');
    expect(fxOf({ fx: 'bogus' })).toBe('none');
    expect(
      fxEmojis([{ fx: 'ghost' }, {}, { fx: 'robot' }, { fx: 'ghost' }, { fx: 'none' }]),
    ).toEqual(['👻', '🤖']);
    expect(fxEmojis([chunk])).toEqual([]);
  });
});

describe('planSchedule with effect tails', () => {
  const c = { id: 'a', startMs: 1000, offsetMs: 100, durationMs: 2000, tailMs: 1500 };
  it('plays the tail after durationMs', () => {
    expect(planSchedule([c], 0, 1)).toEqual([
      { chunkId: 'a', whenDelaySec: 1, bufferOffsetSec: 0.1, durationSec: 3.5 },
    ]);
  });
  it('a chunk is still live inside its tail', () => {
    expect(planSchedule([c], 3500, 1)).toEqual([
      { chunkId: 'a', whenDelaySec: 0, bufferOffsetSec: 2.6, durationSec: 1 },
    ]);
    expect(planSchedule([c], 4500, 1)).toEqual([]);
  });
});
