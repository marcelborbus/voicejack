import type { ClipInfo, PlayerPublic, RoundResultEntry } from '@dub/shared';
import { describe, expect, it } from 'vitest';
import { buildStandings } from '../src/components/results/Leaderboard';

const p = (id: string, total: number): PlayerPublic => ({
  id, name: id, isHost: false, connected: true, micOk: true, ready: true, dubDone: false, totalScore: total,
});
const clip: ClipInfo = {
  id: 'c', title: 'C', url: '/clips/c.mp4', durationMs: 1000, width: 2, height: 1, tags: [],
  attribution: { author: 'a', source: 's', license: 'l' },
};
const e = (playerId: string, points: number): RoundResultEntry => ({
  submissionId: 's' + playerId, playerId, name: playerId, clip, avg: points / 10, votes: 1, points, empty: false,
});

describe('buildStandings', () => {
  it('sorts by total, computes deltas and rank movement', () => {
    const rows = buildStandings([p('a', 100), p('b', 120), p('c', 50)], [e('a', 20), e('b', 90), e('c', 50)]);
    expect(rows.map((r) => [r.playerId, r.rank, r.prevRank, r.delta])).toEqual([
      ['b', 1, 2, 90],
      ['a', 2, 1, 20],
      ['c', 3, 3, 50],
    ]);
  });
  it('lets ties share a rank and treats missing entries as 0', () => {
    const rows = buildStandings([p('a', 80), p('b', 80), p('c', 10)], [e('a', 80)]);
    expect(rows.map((r) => [r.playerId, r.rank, r.delta])).toEqual([
      ['a', 1, 80],
      ['b', 1, 0],
      ['c', 3, 0],
    ]);
    expect(rows.find((r) => r.playerId === 'a')!.prevRank).toBe(3);
  });
});
