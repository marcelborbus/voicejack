import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  ROOM_CODE_REGEX,
  availableClipCount,
  buildFinal,
  buildRoundResult,
  clockOffset,
  collectTags,
  formatClock,
  generateRoomCode,
  laneCount,
  layoutLanes,
  pickClip,
  planSchedule,
  roundWinners,
  scoreSubmission,
  shuffle,
  validateManifest,
  voiceAllowed,
  type ChunkMeta,
  type ClipInfo,
  type RoundResult,
} from '../src/index.js';

/** Deterministic LCG rng in [0,1). */
function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const clip: ClipInfo = {
  id: 'c1',
  title: 'Clip',
  url: '/clips/c1.mp4',
  durationMs: 20_000,
  width: 640,
  height: 360,
  tags: [],
  attribution: { author: 'a', source: 's', license: 'CC-BY' },
};

function meta(
  id: string,
  startMs: number,
  durationMs: number,
  extra: Partial<ChunkMeta> = {},
): ChunkMeta {
  return {
    id,
    startMs,
    durationMs,
    offsetMs: 0,
    mime: 'audio/webm;codecs=opus',
    bytes: 1000,
    ...extra,
  };
}

describe('generateRoomCode', () => {
  it('matches the room code regex', () => {
    const rng = seeded(7);
    for (let i = 0; i < 200; i++) expect(generateRoomCode(rng)).toMatch(ROOM_CODE_REGEX);
  });
  it('is deterministic for a given rng', () => {
    expect(generateRoomCode(seeded(3))).toBe(generateRoomCode(seeded(3)));
  });
  it('handles rng returning values near 1', () => {
    expect(generateRoomCode(() => 0.9999999999)).toMatch(ROOM_CODE_REGEX);
  });
});

describe('shuffle', () => {
  it('is a permutation', () => {
    const xs = [1, 2, 3, 4, 5, 6];
    expect(shuffle(xs, seeded(9)).sort()).toEqual(xs);
  });
});

describe('scoreSubmission', () => {
  it('zero votes → neutral 50 and avg null', () => {
    expect(scoreSubmission([])).toEqual({ avg: null, votes: 0, points: 50 });
  });
  it('mean scaled by 10, rounded', () => {
    expect(scoreSubmission([7, 8])).toEqual({ avg: 7.5, votes: 2, points: 75 });
    expect(scoreSubmission([1, 2, 2]).points).toBe(17);
  });
  it('extremes', () => {
    expect(scoreSubmission([0, 0]).points).toBe(0);
    expect(scoreSubmission([10]).points).toBe(100);
  });
});

describe('buildRoundResult', () => {
  it('empty submission → 0 points and sorted last', () => {
    const r = buildRoundResult(0, clip, [
      { submissionId: 's1', playerId: 'p1', name: 'A', empty: true, votes: [] },
      { submissionId: 's2', playerId: 'p2', name: 'B', empty: false, votes: [0] },
    ]);
    expect(r.entries.map((e) => e.submissionId)).toEqual(['s2', 's1']);
    expect(r.entries[1]).toMatchObject({ points: 0, empty: true, avg: null, votes: 0 });
  });
  it('sorts desc by points and non-empty zero-vote gets 50', () => {
    const r = buildRoundResult(1, clip, [
      { submissionId: 'a', playerId: 'p1', name: 'A', empty: false, votes: [3] },
      { submissionId: 'b', playerId: 'p2', name: 'B', empty: false, votes: [] },
      { submissionId: 'c', playerId: 'p3', name: 'C', empty: false, votes: [9, 10] },
    ]);
    expect(r.entries.map((e) => e.points)).toEqual([95, 50, 30]);
    expect(r.round).toBe(1);
  });
  it('roundWinners includes ties and ignores empties', () => {
    const r = buildRoundResult(0, clip, [
      { submissionId: 'a', playerId: 'p1', name: 'A', empty: false, votes: [8] },
      { submissionId: 'b', playerId: 'p2', name: 'B', empty: false, votes: [8] },
      { submissionId: 'c', playerId: 'p3', name: 'C', empty: true, votes: [] },
    ]);
    expect(roundWinners(r).sort()).toEqual(['p1', 'p2']);
  });
  it('roundWinners empty when all empty', () => {
    const r = buildRoundResult(0, clip, [
      { submissionId: 'a', playerId: 'p1', name: 'A', empty: true, votes: [] },
    ]);
    expect(roundWinners(r)).toEqual([]);
  });
});

describe('buildFinal', () => {
  const players = [
    { playerId: 'p1', name: 'A' },
    { playerId: 'p2', name: 'B' },
    { playerId: 'p3', name: 'C' },
  ];
  const rr = (round: number, pts: Record<string, number | null>): RoundResult => ({
    round,
    clip: { ...clip, id: `c${round}` },
    entries: Object.entries(pts)
      .map(([pid, p]) => ({
        submissionId: `${pid}-r${round}`,
        playerId: pid,
        name: pid,
        avg: p === null ? null : p / 10,
        votes: p === null ? 0 : 1,
        points: p ?? 0,
        empty: p === null,
      }))
      .sort((a, b) => b.points - a.points),
  });
  const chunksOf = (round: number, sub: string) => [
    { ...meta(`${sub}-k`, 0, 1000), url: `/u/${round}/${sub}` },
  ];

  it('sums totals and picks the single winner', () => {
    const f = buildFinal(
      players,
      [rr(0, { p1: 80, p2: 50, p3: 10 }), rr(1, { p1: 20, p2: 60, p3: 10 })],
      chunksOf,
    );
    expect(f.standings.map((s) => [s.playerId, s.total, s.roundWins])).toEqual([
      ['p2', 110, 1],
      ['p1', 100, 1],
      ['p3', 20, 0],
    ]);
    expect(f.winners).toEqual(['p2']);
    expect(f.bestDub).toMatchObject({
      round: 1,
      submissionId: 'p2-r1',
      points: 60,
      playerId: 'p2',
    });
    expect(f.bestDub!.chunks[0]!.url).toBe('/u/1/p2-r1');
  });
  it('tie on total → more round wins wins', () => {
    // p1: 90 + 10 = 100 (1 win); p2: 50 + 50 = 100 (1 win in r1?) make p2 win 2 rounds
    const f = buildFinal(
      players,
      [
        rr(0, { p1: 90, p2: 50, p3: 10 }),
        rr(1, { p1: 0, p2: 30, p3: 20 }),
        rr(2, { p1: 10, p2: 20, p3: 0 }),
      ],
      chunksOf,
    );
    expect(f.standings[0]).toMatchObject({ playerId: 'p2', total: 100, roundWins: 2 });
    expect(f.standings[1]).toMatchObject({ playerId: 'p1', total: 100, roundWins: 1 });
    expect(f.winners).toEqual(['p2']);
  });
  it('full tie → shared winners, bestDub from first by standings', () => {
    const f = buildFinal(players, [rr(0, { p1: 50, p2: 50, p3: 10 })], chunksOf);
    expect(f.winners).toEqual(['p1', 'p2']);
    expect(f.bestDub?.playerId).toBe('p1');
  });
  it('bestDub prefers later round on equal points', () => {
    const f = buildFinal(players, [rr(0, { p1: 70, p2: 10 }), rr(1, { p1: 70, p2: 10 })], chunksOf);
    expect(f.bestDub).toMatchObject({ round: 1, points: 70 });
  });
  it('bestDub null when the winner only has empty dubs', () => {
    const f = buildFinal([{ playerId: 'p1', name: 'A' }], [rr(0, { p1: null })], chunksOf);
    expect(f.winners).toEqual(['p1']);
    expect(f.bestDub).toBeNull();
  });
  it('no players → no winners', () => {
    expect(buildFinal([], [], chunksOf)).toEqual({ winners: [], standings: [], bestDub: null });
  });
});

describe('clip picking', () => {
  const lib = [
    { id: 'a', tags: ['movie'] },
    { id: 'b', tags: ['meme'] },
    { id: 'c', tags: ['movie', 'old'] },
  ];
  it('[] tags = all', () => {
    expect(availableClipCount(lib, [], [])).toBe(3);
  });
  it('filters by tags (any match) and used ids', () => {
    expect(availableClipCount(lib, ['movie'], ['a'])).toBe(1);
    expect(pickClip(lib, ['movie'], new Set(['a']), seeded(1))?.id).toBe('c');
  });
  it('returns null when exhausted', () => {
    expect(pickClip(lib, [], ['a', 'b', 'c'])).toBeNull();
  });
  it('collectTags is sorted and unique', () => {
    expect(collectTags(lib)).toEqual(['meme', 'movie', 'old']);
  });
});

describe('layoutLanes', () => {
  it('non-overlapping chunks share lane 0', () => {
    const l = layoutLanes([meta('a', 0, 1000), meta('b', 1000, 500), meta('c', 3000, 100)]);
    expect([...l.values()]).toEqual([0, 0, 0]);
    expect(laneCount(l)).toBe(1);
  });
  it('overlapping chunks stack into lanes', () => {
    const l = layoutLanes([
      meta('a', 0, 5000),
      meta('b', 1000, 1000),
      meta('c', 1500, 3000),
      meta('d', 2500, 100),
    ]);
    expect(l.get('a')).toBe(0);
    expect(l.get('b')).toBe(1);
    expect(l.get('c')).toBe(2);
    expect(l.get('d')).toBe(1); // b ended at 2000
    expect(laneCount(l)).toBe(3);
  });
  it('is independent of input order', () => {
    const xs = [meta('a', 0, 5000), meta('b', 1000, 1000), meta('c', 1500, 3000)];
    expect(layoutLanes(xs.slice().reverse())).toEqual(layoutLanes(xs));
  });
  it('empty input', () => {
    expect(laneCount(layoutLanes([]))).toBe(0);
  });
});

describe('planSchedule', () => {
  const chunks = [
    meta('a', 1000, 2000, { offsetMs: 100 }),
    meta('b', 5000, 1000),
    meta('c', 0, 500),
  ];
  it('from 0 at 1×: future chunks delayed, past skipped none', () => {
    const p = planSchedule(chunks, 0, 1);
    expect(p).toEqual([
      { chunkId: 'c', whenDelaySec: 0, bufferOffsetSec: 0, durationSec: 0.5 },
      { chunkId: 'a', whenDelaySec: 1, bufferOffsetSec: 0.1, durationSec: 2 },
      { chunkId: 'b', whenDelaySec: 5, bufferOffsetSec: 0, durationSec: 1 },
    ]);
  });
  it('mid-chunk with offsetMs at 2×', () => {
    const p = planSchedule(chunks, 2000, 2);
    expect(p[0]).toEqual({ chunkId: 'a', whenDelaySec: 0, bufferOffsetSec: 1.1, durationSec: 1 });
    expect(p[1]).toEqual({ chunkId: 'b', whenDelaySec: 1.5, bufferOffsetSec: 0, durationSec: 1 });
    expect(p).toHaveLength(2); // c already ended
  });
  it('skips chunks ending exactly at media time', () => {
    expect(planSchedule([meta('x', 0, 1000)], 1000, 1)).toEqual([]);
  });
  it('half speed doubles delays', () => {
    expect(planSchedule([meta('x', 2000, 1000)], 1000, 0.5)[0]!.whenDelaySec).toBe(2);
  });
  it('invalid rate → nothing', () => {
    expect(planSchedule(chunks, 0, 0)).toEqual([]);
  });
});

describe('clockOffset', () => {
  it('uses the min-RTT sample', () => {
    const e = clockOffset([
      { c0: 0, c1: 100, s: 1000 },
      { c0: 200, c1: 210, s: 1205 },
      { c0: 300, c1: 380, s: 1400 },
    ]);
    expect(e).toEqual({ offset: 1000, rtt: 10 });
  });
  it('null for no samples', () => {
    expect(clockOffset([])).toBeNull();
  });
  it('ignores negative-RTT samples', () => {
    expect(clockOffset([{ c0: 10, c1: 5, s: 0 }])).toBeNull();
  });
});

describe('voiceAllowed', () => {
  it.each([
    ['LOBBY', null, true],
    ['DUBBING', null, false],
    ['SHOWCASE', 'LOADING', true],
    ['SHOWCASE', 'PLAYING', true],
    ['SHOWCASE', 'LOCKED', true],
    ['ROUND_RESULTS', null, true],
    ['FINAL', null, true],
  ] as const)('%s/%s → %s', (phase, status, expected) => {
    expect(voiceAllowed(phase, status)).toBe(expected);
  });
});

describe('validateManifest', () => {
  it('accepts and sorts by startMs', () => {
    const r = validateManifest([meta('b', 5000, 1000), meta('a', 100, 1000)], 20_000, LIMITS);
    expect(r.ok && r.chunks.map((c) => c.id)).toEqual(['a', 'b']);
  });
  it('rejects duplicate ids', () => {
    expect(validateManifest([meta('a', 0, 1000), meta('a', 2000, 1000)], 20_000, LIMITS).ok).toBe(
      false,
    );
  });
  it('rejects too many chunks', () => {
    const many = Array.from({ length: LIMITS.maxChunksPerSubmission + 1 }, (_, i) =>
      meta(`c${i}`, i * 10, 400),
    );
    expect(validateManifest(many, 20_000, LIMITS).ok).toBe(false);
  });
  it('rejects too short, out of clip, and oversized', () => {
    expect(validateManifest([meta('a', 0, 100)], 20_000, LIMITS).ok).toBe(false);
    expect(validateManifest([meta('a', 20_000, 1000)], 20_000, LIMITS).ok).toBe(false);
    expect(validateManifest([meta('a', 18_000, 5000)], 20_000, LIMITS).ok).toBe(false);
    expect(
      validateManifest([meta('a', 0, 1000, { bytes: LIMITS.maxChunkBytes + 1 })], 20_000, LIMITS)
        .ok,
    ).toBe(false);
  });
  it('rejects submission total over limit', () => {
    const big = Array.from({ length: 9 }, (_, i) =>
      meta(`c${i}`, i * 1000, 500, { bytes: LIMITS.maxChunkBytes }),
    );
    expect(validateManifest(big, 20_000, LIMITS).ok).toBe(false);
  });
  it('accepts an empty manifest', () => {
    expect(validateManifest([], 20_000, LIMITS)).toEqual({ ok: true, chunks: [] });
  });
});

describe('formatClock', () => {
  it.each([
    [0, '0:00'],
    [999, '0:00'],
    [61_000, '1:01'],
    [210_000, '3:30'],
    [-5, '0:00'],
    [3_723_000, '1:02:03'],
  ])('%d → %s', (ms, s) => {
    expect(formatClock(ms)).toBe(s);
  });
  it('ceil mode for countdowns', () => {
    expect(formatClock(100, 'ceil')).toBe('0:01');
  });
});
