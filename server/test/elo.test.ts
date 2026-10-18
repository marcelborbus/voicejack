import { describe, expect, it } from 'vitest';
import { RANKED_MIN_GAMES, formatEloDelta, rankedUnlocked } from '@dub/shared';
import {
  eloK,
  expectedScore,
  pairwiseElo,
  placesOf,
  rawEloDeltas,
  type EloInput,
} from '../src/elo/elo.js';
import { openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { Accounts } from '../src/accounts/Accounts.js';
import { Ratings } from '../src/elo/Ratings.js';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const field = (ratings: number[]): EloInput[] =>
  ratings.map((rating, i) => ({ id: `p${i}`, rating, place: i + 1 }));

describe('Elo math (V09)', () => {
  it('K = 32 / (n − 1)', () => {
    expect(eloK(1)).toBe(0);
    expect(eloK(2)).toBe(32);
    expect(eloK(3)).toBe(16);
    expect(eloK(5)).toBe(8);
    expect(eloK(6)).toBeCloseTo(6.4);
  });

  it('two equal players: winner +16, loser −16', () => {
    expect(pairwiseElo(field([1000, 1000]))).toEqual([
      { id: 'p0', before: 1000, after: 1016, delta: 16 },
      { id: 'p1', before: 1000, after: 984, delta: -16 },
    ]);
  });

  it('a tie between equals changes nothing; a tie against a stronger player gains', () => {
    const tie = pairwiseElo([
      { id: 'a', rating: 1000, place: 1 },
      { id: 'b', rating: 1000, place: 1 },
    ]);
    expect(tie.map((c) => c.delta)).toEqual([0, 0]);
    const upset = pairwiseElo([
      { id: 'a', rating: 1200, place: 1 },
      { id: 'b', rating: 1000, place: 1 },
    ]);
    expect(upset[0]!.delta).toBeLessThan(0);
    expect(upset[1]!.delta).toBeGreaterThan(0);
    expect(upset[0]!.delta + upset[1]!.delta).toBe(0);
  });

  it('expected score is symmetric and 0.5 for equals', () => {
    expect(expectedScore(1000, 1000)).toBe(0.5);
    expect(expectedScore(1200, 1000) + expectedScore(1000, 1200)).toBeCloseTo(1, 12);
    expect(expectedScore(1400, 1000)).toBeCloseTo(10 / 11, 12);
  });

  it.each([2, 3, 4, 5, 6])('%i equal players: first +16, last −16, middle scaled', (n) => {
    const d = pairwiseElo(field(Array(n).fill(1000))).map((c) => c.delta);
    expect(d[0]).toBe(16);
    expect(d[n - 1]).toBe(-16);
    // Equal field: Δ_i = K · ((n − i) − 1 − (n − 1)/2) with K = 32/(n − 1).
    d.forEach((x, i) => expect(x).toBe(Math.round((32 / (n - 1)) * ((n - 1) / 2 - i)) || 0));
    for (let i = 1; i < n; i++) expect(d[i]!).toBeLessThanOrEqual(d[i - 1]!);
  });

  it.each([
    [[1000, 1000]],
    [[1500, 900, 1100]],
    [[1000, 1013, 987, 1200]],
    [[800, 1600, 1000, 1250, 1100]],
    [[1000, 1000, 1000, 1000, 1000, 1000]],
    [[1312, 977, 1041, 1500, 860, 1199]],
  ])('conservation: deltas sum to ≈ 0 (%j)', (ratings) => {
    const players = field(ratings);
    expect(sum(rawEloDeltas(players))).toBeCloseTo(0, 9);
    const rounded = pairwiseElo(players).map((c) => c.delta);
    expect(Math.abs(sum(rounded))).toBeLessThanOrEqual(players.length / 2);
    // Never more than the total K (all pairings won / lost).
    for (const x of rounded) expect(Math.abs(x)).toBeLessThanOrEqual(32);
  });

  it('ties in a bigger game: shared first place is a draw between them', () => {
    const c = pairwiseElo([
      { id: 'a', rating: 1000, place: 1 },
      { id: 'b', rating: 1000, place: 1 },
      { id: 'c', rating: 1000, place: 3 },
    ]);
    expect(c.map((x) => x.delta)).toEqual([8, 8, -16]);
  });

  it('places: more points first, then round wins; ties share a place', () => {
    expect(
      placesOf([
        { total: 30, roundWins: 1 },
        { total: 30, roundWins: 1 },
        { total: 30, roundWins: 0 },
        { total: 10, roundWins: 2 },
      ]),
    ).toEqual([1, 1, 3, 4]);
  });

  it('shared helpers: ranked unlock + delta format', () => {
    expect(rankedUnlocked(null)).toBe(false);
    expect(rankedUnlocked({ publicGamesPlayed: RANKED_MIN_GAMES - 1 })).toBe(false);
    expect(rankedUnlocked({ publicGamesPlayed: RANKED_MIN_GAMES })).toBe(true);
    expect(formatEloDelta(19)).toBe('+19');
    expect(formatEloDelta(-7)).toBe('−7');
    expect(formatEloDelta(0)).toBe('±0');
  });
});

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  let t = 1_700_000_000_000;
  const now = () => t++;
  return { db, accounts: new Accounts(db, now), ratings: new Ratings(db, now) };
}

describe('Ratings (V09)', () => {
  it('records a public game: rows, Elo, games played; bots and account-less seats excluded', () => {
    const { db, accounts, ratings } = setup();
    const [a, b, c] = [accounts.createGuest(), accounts.createGuest(), accounts.createGuest()];
    const r = ratings.recordGame({
      kind: 'casual',
      roomCode: 'ABCDEF',
      seats: [
        { userId: a.id, isBot: false, total: 40, roundWins: 2 },
        { userId: null, isBot: true, total: 35, roundWins: 1 },
        { userId: b.id, isBot: false, total: 20, roundWins: 0 },
        { userId: null, isBot: false, total: 10, roundWins: 0 },
        { userId: c.id, isBot: false, total: 20, roundWins: 0 },
      ],
    })!;
    expect(r.changes.map((x) => [x.id, x.place, x.delta])).toEqual([
      [a.id, 1, 16],
      [b.id, 3, -8],
      [c.id, 3, -8],
    ]);
    expect(accounts.getUser(a.id)).toMatchObject({ elo: 1016, publicGamesPlayed: 1 });
    expect(accounts.getUser(b.id)).toMatchObject({ elo: 992, publicGamesPlayed: 1 });
    const rows = db.prepare('SELECT * FROM game_players ORDER BY place, user_id').all();
    expect(rows).toHaveLength(3);
    expect(db.prepare('SELECT kind, room_code FROM games').all()).toEqual([
      { kind: 'casual', room_code: 'ABCDEF' },
    ]);
    expect(ratings.lastGame(a.id, 'ABCDEF')).toMatchObject({
      kind: 'casual',
      place: 1,
      players: 3,
      total: 40,
      eloBefore: 1000,
      eloAfter: 1016,
    });
    expect(ratings.lastGame(a.id, 'ZZZZZZ')).toBeNull();
  });

  it('a lone rated human still counts the game, with no rating change', () => {
    const { accounts, ratings } = setup();
    const a = accounts.createGuest();
    ratings.recordGame({
      kind: 'ranked',
      roomCode: 'ABCDEF',
      seats: [
        { userId: a.id, isBot: false, total: 1, roundWins: 0 },
        { userId: null, isBot: false, total: 9, roundWins: 3 },
      ],
    });
    expect(accounts.getUser(a.id)).toMatchObject({ elo: 1000, publicGamesPlayed: 1 });
    expect(ratings.recordGame({ kind: 'casual', roomCode: 'ABCDEF', seats: [] })).toBeNull();
  });

  function playTwo(ratings: Ratings, winner: string, loser: string, code = 'ABCDEF') {
    ratings.recordGame({
      kind: 'casual',
      roomCode: code,
      seats: [
        { userId: winner, isBot: false, total: 10, roundWins: 1 },
        { userId: loser, isBot: false, total: 0, roundWins: 0 },
      ],
    });
  }

  function claim(accounts: Accounts, email: string, guestId: string) {
    return accounts.consumeLoginToken(accounts.createLoginToken(email, guestId))!;
  }

  it('merge into an account with 0 games: rating and game history move to it', () => {
    const { db, accounts, ratings } = setup();
    const reg = claim(accounts, 'x@example.com', accounts.createGuest().id).user;
    const guest = accounts.createGuest();
    const other = accounts.createGuest();
    playTwo(ratings, guest.id, other.id);
    const r = claim(accounts, 'x@example.com', guest.id);
    expect(r.merged).toBe(true);
    expect(r.user).toMatchObject({ id: reg.id, elo: 1016, publicGamesPlayed: 1 });
    const owners = db.prepare('SELECT user_id FROM game_players ORDER BY user_id').all();
    expect(owners.map((o) => (o as { user_id: string }).user_id).sort()).toEqual(
      [reg.id, other.id].sort(),
    );
    expect(accounts.getUser(guest.id)).toMatchObject({ elo: 1000, publicGamesPlayed: 0 });
    expect(ratings.lastGame(reg.id, 'ABCDEF')?.eloAfter).toBe(1016);
  });

  it('merge into an account that has played: both keep their own rating and history', () => {
    const { db, accounts, ratings } = setup();
    const reg = claim(accounts, 'y@example.com', accounts.createGuest().id).user;
    const guest = accounts.createGuest();
    const other = accounts.createGuest();
    playTwo(ratings, other.id, reg.id, 'AAAAAA');
    playTwo(ratings, guest.id, other.id, 'BBBBBB');
    const r = claim(accounts, 'y@example.com', guest.id);
    expect(r.user).toMatchObject({ id: reg.id, elo: 984, publicGamesPlayed: 1 });
    expect(accounts.getUser(guest.id)).toMatchObject({ publicGamesPlayed: 1 });
    const n = (id: string) =>
      (
        db.prepare('SELECT COUNT(*) AS n FROM game_players WHERE user_id = ?').get(id) as {
          n: number;
        }
      ).n;
    expect(n(reg.id)).toBe(1);
    expect(n(guest.id)).toBe(1);
  });
});
