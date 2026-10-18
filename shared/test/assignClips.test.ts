import { describe, expect, it } from 'vitest';
import { assignClips, emptyClipHistory, recordClips, type ClipHistory } from '../src/index.js';

function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const lib = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}` }));
const players = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
const ids = (m: Map<string, { id: string }>) => [...m.values()].map((c) => c.id);

/** Plays `rounds` deals and returns each round's assignment. */
function play(ps: string[], library: { id: string }[], rounds: number, h: ClipHistory, seed = 1) {
  const rng = seeded(seed);
  const out: Map<string, { id: string }>[] = [];
  for (let r = 0; r < rounds; r++) {
    const a = assignClips(ps, library, h, rng)!;
    recordClips(h, a);
    out.push(a);
  }
  return out;
}

describe('assignClips', () => {
  it('gives every player a clip, distinct within the round', () => {
    const a = assignClips(players(8), lib(8), emptyClipHistory(), seeded(3))!;
    expect([...a.keys()]).toEqual(players(8));
    expect(new Set(ids(a)).size).toBe(8);
  });

  it('empty player list → empty map; empty library → null', () => {
    expect(assignClips([], lib(0), emptyClipHistory())?.size).toBe(0);
    expect(assignClips(['p0'], lib(0), emptyClipHistory())).toBeNull();
  });

  it('prefers clips nobody has had yet', () => {
    const h = emptyClipHistory();
    const rounds = play(players(3), lib(9), 3, h);
    const all = rounds.flatMap(ids);
    expect(new Set(all).size).toBe(9);
  });

  it('owner case: 12 clips, 8 players × 3 rounds → distinct per round, no repeats per player', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const h = emptyClipHistory();
      const ps = players(8);
      const rounds = play(ps, lib(12), 3, h, seed);
      for (const a of rounds) expect(new Set(ids(a)).size).toBe(8);
      for (const p of ps) {
        const mine = rounds.map((a) => a.get(p)!.id);
        expect(new Set(mine).size).toBe(3);
      }
      // Round 2 uses the 4 fresh clips before any reused one.
      const fresh = new Set(lib(12).map((c) => c.id));
      for (const id of ids(rounds[0]!)) fresh.delete(id);
      expect(ids(rounds[1]!).filter((id) => fresh.has(id))).toHaveLength(4);
    }
  });

  it('reuses the least recently used clips first', () => {
    const h = emptyClipHistory();
    recordClips(h, new Map([['x', { id: 'c0' }]])); // deal 1
    recordClips(h, new Map([['x', { id: 'c1' }]])); // deal 2
    recordClips(h, new Map([['x', { id: 'c2' }]])); // deal 3
    const a = assignClips(['p0'], lib(3), h, seeded(5))!;
    expect(a.get('p0')!.id).toBe('c0');
  });

  it('never repeats a clip for a player when a matching exists', () => {
    // p0 had c0+c1, p1 had c1; only c0,c1,c2 exist → p0 must get c2, p1 gets c0.
    const h = emptyClipHistory();
    h.seen.set('p0', new Set(['c0', 'c1']));
    h.seen.set('p1', new Set(['c1']));
    for (let seed = 1; seed <= 20; seed++) {
      const a = assignClips(['p0', 'p1'], lib(3), h, seeded(seed))!;
      expect(a.get('p0')!.id).toBe('c2');
      expect(a.get('p1')!.id).toBe('c0');
    }
  });

  it('last resort: a player who had every clip gets a repeat, still distinct in the round', () => {
    const h = emptyClipHistory();
    h.seen.set('p0', new Set(['c0', 'c1']));
    const a = assignClips(['p0', 'p1'], lib(2), h, seeded(2))!;
    expect(new Set(ids(a)).size).toBe(2);
  });

  it('last resort: fewer clips than players repeats clips within the round', () => {
    const a = assignClips(players(3), lib(2), emptyClipHistory(), seeded(2))!;
    expect(a.size).toBe(3);
    expect(new Set(ids(a)).size).toBe(2);
  });

  it('recordClips tracks per-player history and recency', () => {
    const h = emptyClipHistory();
    recordClips(
      h,
      new Map([
        ['p0', { id: 'c0' }],
        ['p1', { id: 'c1' }],
      ]),
    );
    expect(h.deals).toBe(1);
    expect(h.lastUsed.get('c1')).toBe(1);
    expect([...h.seen.get('p0')!]).toEqual(['c0']);
  });
});
