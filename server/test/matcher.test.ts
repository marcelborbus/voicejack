import { describe, expect, it } from 'vitest';
import { Matcher, type QueueEntry } from '../src/match/Matcher.js';

const T0 = 1_000_000;
const e = (key: string, joinedAt = T0): QueueEntry => ({ key, joinedAt });
const keys = (groups: QueueEntry[][]) => groups.map((g) => g.map((x) => x.key));

function queued(n: number, joinedAt = T0): Matcher {
  const m = new Matcher();
  for (let i = 0; i < n; i++) m.join(e(`p${i}`, joinedAt));
  return m;
}

describe('Matcher thresholds', () => {
  it('starts 6 at once, keeping the rest queued in order', () => {
    const m = queued(8);
    expect(keys(m.take(T0))).toEqual([['p0', 'p1', 'p2', 'p3', 'p4', 'p5']]);
    expect(m.entries().map((x) => x.key)).toEqual(['p6', 'p7']);
  });

  it('12 queued → two full games', () => {
    expect(queued(12).take(T0)).toHaveLength(2);
  });

  it('3–5 wait until the oldest waited 20 s', () => {
    const m = queued(5);
    expect(m.take(T0 + 19_999)).toEqual([]);
    expect(keys(m.take(T0 + 20_000))).toEqual([['p0', 'p1', 'p2', 'p3', 'p4']]);
    expect(m.size).toBe(0);
  });

  it('a newcomer rides along once the oldest waited 20 s', () => {
    const m = new Matcher();
    m.join(e('old', T0));
    m.join(e('mid', T0 + 5_000));
    m.join(e('new', T0 + 19_000));
    expect(keys(m.take(T0 + 20_000))).toEqual([['old', 'mid', 'new']]);
  });

  it('2 players only after 60 s', () => {
    const m = queued(2);
    expect(m.take(T0 + 20_000)).toEqual([]);
    expect(m.take(T0 + 59_999)).toEqual([]);
    expect(keys(m.take(T0 + 60_000))).toEqual([['p0', 'p1']]);
  });

  it('1 player never matches', () => {
    expect(queued(1).take(T0 + 3_600_000)).toEqual([]);
  });

  it('thresholds are configurable', () => {
    const m = new Matcher({ fullWaitMs: 100, pairWaitMs: 200, maxPlayers: 4 });
    for (const k of ['a', 'b']) m.join(e(k));
    expect(m.take(T0 + 150)).toEqual([]);
    expect(keys(m.take(T0 + 200))).toEqual([['a', 'b']]);
    expect(() => new Matcher({ minPlayers: 1 })).toThrow();
  });
});

describe('Matcher clip cap (V13)', () => {
  it('never forms a match larger than the cap', () => {
    const m = queued(6);
    expect(keys(m.take(T0, 4))).toEqual([['p0', 'p1', 'p2', 'p3']]);
    expect(m.entries().map((x) => x.key)).toEqual(['p4', 'p5']);
  });

  it('a cap below minPlayers starts full (capped) matches at once', () => {
    expect(keys(queued(3).take(T0, 2))).toEqual([['p0', 'p1']]);
  });

  it('matches nobody below 2 clips', () => {
    const m = queued(6);
    expect(m.take(T0 + 120_000, 1)).toEqual([]);
    expect(m.size).toBe(6);
  });
});

describe('Matcher queue', () => {
  it('re-join keeps the position; leave and position', () => {
    const m = queued(3);
    m.join(e('p0', T0 + 999)); // same key: replaced in place
    expect(m.position('p0')).toBe(1);
    expect(m.get('p0')!.joinedAt).toBe(T0 + 999);
    expect(m.leave('p1')!.key).toBe('p1');
    expect(m.leave('p1')).toBeUndefined();
    expect(m.position('p2')).toBe(2);
    expect(m.position('nope')).toBeNull();
  });

  it('a requeued player goes to the front and keeps the wait time', () => {
    const m = new Matcher();
    for (let i = 0; i < 5; i++) m.join(e(`n${i}`, T0 + 50_000));
    m.requeueFront(e('back', T0)); // missed a ready check, waited since T0
    expect(m.position('back')).toBe(1);
    // Their old wait counts: at T0+20s the group forms anchored on them.
    const g = m.take(T0 + 20_000);
    expect(keys(g)).toEqual([['back', 'n0', 'n1', 'n2', 'n3', 'n4']]);
  });

  it('front-of-queue players are picked first when more than 6 are waiting', () => {
    const m = queued(6, T0 + 1_000);
    m.requeueFront(e('front', T0));
    const [g] = m.take(T0 + 1_000);
    expect(g!.map((x) => x.key)).toEqual(['front', 'p0', 'p1', 'p2', 'p3', 'p4']);
    expect(m.entries().map((x) => x.key)).toEqual(['p5']);
  });
});

describe('Matcher hooks (V09 seam)', () => {
  type Rated = QueueEntry & { elo: number };
  const r = (key: string, elo: number, joinedAt = T0): Rated => ({ key, elo, joinedAt });

  it('compatible() gets the anchor wait and filters candidates; score() orders them', () => {
    const seen: number[] = [];
    const m = new Matcher<Rated>({
      maxPlayers: 3,
      compatible: (a, b, waitedMs) => {
        seen.push(waitedMs);
        return Math.abs(a.elo - b.elo) <= 100 + 50 * Math.floor(waitedMs / 5000);
      },
      score: (a, b) => -Math.abs(a.elo - b.elo),
    });
    m.join(r('a', 1000));
    m.join(r('far', 1400));
    m.join(r('b', 1090));
    m.join(r('c', 1010));
    m.join(r('d', 1050));
    // Full group of 3 from the closest ratings to the anchor; `far` is out of the window.
    expect(keys(m.take(T0))).toEqual([['a', 'c', 'd']]);
    expect(seen.every((w) => w === 0)).toBe(true);
    expect(m.entries().map((x) => x.key)).toEqual(['far', 'b']);
  });
});
