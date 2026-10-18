import { describe, expect, it } from 'vitest';
import type { QueueMode } from '@dub/shared';
import { Matcher, type MatchContext } from '../src/match/Matcher.js';
import {
  eloMatchRules,
  rankedCompatible,
  rankedScore,
  rankedWindow,
  type RatedEntry,
} from '../src/match/ranked.js';

const T0 = 1_000_000;
const e = (key: string, elo: number, joinedAt = T0, mode: QueueMode = 'ranked'): RatedEntry => ({
  key,
  elo,
  joinedAt,
  mode,
});
const ctx = (queue: RatedEntry[], now = T0): MatchContext<RatedEntry> => ({ now, queue });
const matcher = () => new Matcher<RatedEntry>(eloMatchRules<RatedEntry>());
const keys = (groups: RatedEntry[][]) => groups.map((g) => g.map((x) => x.key));

describe('ranked window (V09)', () => {
  it('±100, widening by 50 every 5 s, anyone after 45 s', () => {
    expect(rankedWindow(0)).toBe(100);
    expect(rankedWindow(4_999)).toBe(100);
    expect(rankedWindow(5_000)).toBe(150);
    expect(rankedWindow(12_000)).toBe(200);
    expect(rankedWindow(40_000)).toBe(500);
    expect(rankedWindow(44_999)).toBe(500);
    expect(rankedWindow(45_000)).toBe(Infinity);
  });

  it('compatible inside the window only; casual and ranked never mix', () => {
    const a = e('a', 1000);
    const near = e('n', 1100);
    const far = e('f', 1101);
    const q = ctx([a, near, far, e('x', 1050), e('y', 950)]);
    expect(rankedCompatible(a, near, 0, q)).toBe(true);
    expect(rankedCompatible(a, far, 0, q)).toBe(false);
    expect(rankedCompatible(a, far, 5_000, q)).toBe(true);
    expect(rankedCompatible(a, e('c', 1000, T0, 'casual'), 0, q)).toBe(false);
    expect(rankedCompatible(e('c', 1000, T0, 'casual'), e('d', 3000, T0, 'casual'), 0, q)).toBe(
      true,
    );
    expect(rankedCompatible(a, e('z', 3000), 45_000, q)).toBe(true);
  });

  it('tolerance: after 20 s with < 3 ranked inside the window, anyone ranked fits', () => {
    const a = e('a', 1000);
    const far = e('f', 2000);
    const lonely = ctx([a, e('b', 1050), far]); // 2 inside (a, b)
    expect(rankedCompatible(a, far, 19_999, lonely)).toBe(false);
    expect(rankedCompatible(a, far, 20_000, lonely)).toBe(true);
    const busy = ctx([a, e('b', 1050), e('c', 950), far]); // 3 inside
    expect(rankedCompatible(a, far, 20_000, busy)).toBe(false);
    // Casual players never count towards the ranked window.
    const mixed = ctx([a, e('b', 1050), e('c', 1000, T0, 'casual'), far]);
    expect(rankedCompatible(a, far, 20_000, mixed)).toBe(true);
  });

  it('score prefers the closest Elo in ranked, none in casual', () => {
    const a = e('a', 1000);
    expect(rankedScore(a, e('b', 1010))).toBeGreaterThan(rankedScore(a, e('c', 960)));
    expect(rankedScore(e('a', 1000, T0, 'casual'), e('b', 2000, T0, 'casual'))).toBe(0);
  });
});

describe('Matcher with ranked rules (V09)', () => {
  it('6 inside the window match at once, closest Elo first', () => {
    const m = matcher();
    for (const [k, elo] of [
      ['a', 1000],
      ['far', 1400],
      ['b', 1090],
      ['c', 1010],
      ['d', 960],
      ['e', 1001],
      ['f', 1040],
      ['g', 1099],
    ] as const)
      m.join(e(k, elo));
    const groups = m.take(T0);
    expect(keys(groups)).toEqual([['a', 'e', 'c', 'd', 'f', 'b']]);
    expect(m.entries().map((x) => x.key)).toEqual(['far', 'g']);
  });

  it('a far-off pair waits; the window widens with time', () => {
    const m = matcher();
    m.join(e('a', 1000));
    m.join(e('b', 1500, T0 + 1));
    m.join(e('c', 1510, T0 + 2));
    // 20 s: a's window is ±300 and holds only a itself (< 3): tolerance, anyone ranked fits.
    expect(keys(m.take(T0 + 19_000))).toEqual([]);
    expect(keys(m.take(T0 + 20_000))).toEqual([['a', 'b', 'c']]);
  });

  it('busy server: no widening to everyone at 20 s, a match inside the window instead', () => {
    const m = matcher();
    m.join(e('a', 1000));
    m.join(e('b', 1050));
    m.join(e('c', 980));
    m.join(e('x', 1900));
    m.join(e('y', 1950));
    const g = keys(m.take(T0 + 20_000));
    expect(g).toEqual([['a', 'c', 'b']]);
    expect(m.entries().map((x) => x.key)).toEqual(['x', 'y']);
  });

  it('casual is V08 as before and never mixes with ranked', () => {
    const m = matcher();
    m.join(e('r1', 1000));
    m.join(e('c1', 1000, T0, 'casual'));
    m.join(e('r2', 1000));
    m.join(e('c2', 3000, T0, 'casual'));
    m.join(e('c3', 500, T0, 'casual'));
    m.join(e('r3', 1000));
    const g = keys(m.take(T0 + 20_000));
    expect(g).toEqual([
      ['r1', 'r2', 'r3'],
      ['c1', 'c2', 'c3'],
    ]);
  });
});
