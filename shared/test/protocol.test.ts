import { describe, expect, it } from 'vitest';
import {
  C2SSchema,
  ChunkMetaSchema,
  ClipManifestSchema,
  GameSettingsSchema,
  NORMAL_SETTINGS,
  PROTOCOL_VERSION,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_REGEX,
  parseC2S,
  paths,
  type C2S,
  type ChunkMeta,
} from '../src/index.js';

const chunk: ChunkMeta = {
  id: '3f1c2a9e-1b2c-4d5e-8f90-123456789abc',
  startMs: 1200,
  offsetMs: 35,
  durationMs: 2400,
  mime: 'audio/webm;codecs=opus',
  bytes: 18_000,
};

describe('C2S schema', () => {
  it('round-trips a valid vote', () => {
    const msg: C2S = { t: 'vote', submissionId: 'abcDEF123456', score: 7 };
    expect(parseC2S(JSON.stringify(msg))).toEqual(msg);
  });

  it.each([
    { t: 'vote', submissionId: 'abc', score: 11 },
    { t: 'vote', submissionId: 'abc', score: 3.5 },
    { t: 'vote', submissionId: 'abc', score: -1 },
    { t: 'vote', score: 5 },
    { t: 'nope' },
  ])('rejects invalid message %j', (msg) => {
    expect(C2SSchema.safeParse(msg).success).toBe(false);
  });

  it('rejects malformed JSON', () => {
    expect(parseC2S('{not json')).toBeNull();
  });

  it('accepts hello with name and trims it', () => {
    const r = C2SSchema.parse({ t: 'hello', v: PROTOCOL_VERSION, code: 'ABC234', name: '  Ann ' });
    expect(r).toEqual({ t: 'hello', v: 1, code: 'ABC234', name: 'Ann' });
  });

  it('rejects hello with a bad room code or overlong name', () => {
    expect(C2SSchema.safeParse({ t: 'hello', v: 1, code: 'ABC10I' }).success).toBe(false);
    expect(
      C2SSchema.safeParse({ t: 'hello', v: 1, code: 'ABC234', name: 'x'.repeat(21) }).success,
    ).toBe(false);
  });

  it('round-trips manifest and partial settings', () => {
    const m: C2S = { t: 'manifest', round: 0, chunks: [chunk] };
    expect(parseC2S(JSON.stringify(m))).toEqual(m);
    const s: C2S = { t: 'updateSettings', settings: { mode: 'extended', rounds: 5 } };
    expect(parseC2S(JSON.stringify(s))).toEqual(s);
  });

  it('round-trips rtc signals', () => {
    const offer: C2S = {
      t: 'rtc',
      to: 'p1',
      data: { kind: 'description', description: { type: 'offer', sdp: 'v=0' } },
    };
    const cand: C2S = { t: 'rtc', to: 'p1', data: { kind: 'candidate', candidate: null } };
    expect(parseC2S(JSON.stringify(offer))).toEqual(offer);
    expect(parseC2S(JSON.stringify(cand))).toEqual(cand);
  });
});

describe('shared schemas', () => {
  it('NORMAL_SETTINGS is valid', () => {
    expect(GameSettingsSchema.parse(NORMAL_SETTINGS)).toEqual(NORMAL_SETTINGS);
  });

  it('ChunkMeta rejects unknown mime and big offset', () => {
    expect(ChunkMetaSchema.safeParse({ ...chunk, mime: 'audio/wav' }).success).toBe(false);
    expect(ChunkMetaSchema.safeParse({ ...chunk, offsetMs: 5000 }).success).toBe(false);
  });

  it('ClipManifest validates entries and rejects duplicates / paths', () => {
    const entry = {
      id: 'bbb-1',
      title: 'Bunny',
      file: 'bbb-1.mp4',
      durationMs: 20_000,
      width: 1280,
      height: 720,
      attribution: { author: 'Blender Foundation', source: 'x', license: 'CC-BY 3.0' },
    };
    expect(ClipManifestSchema.parse({ clips: [entry] }).clips[0]?.tags).toEqual([]);
    expect(ClipManifestSchema.safeParse({ clips: [entry, entry] }).success).toBe(false);
    expect(ClipManifestSchema.safeParse({ clips: [{ ...entry, file: '../x.mp4' }] }).success).toBe(
      false,
    );
  });

  it('room code alphabet matches the regex', () => {
    expect(ROOM_CODE_ALPHABET).toHaveLength(31);
    expect(ROOM_CODE_REGEX.test(ROOM_CODE_ALPHABET.slice(0, 6))).toBe(true);
  });

  it('builds REST paths', () => {
    expect(paths.chunk('ABC234', 1, 's1', 'c1')).toBe(
      '/api/rooms/ABC234/rounds/1/subs/s1/chunks/c1',
    );
  });
});
