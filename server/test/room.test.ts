import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, type ChunkMeta, type ClipInfo, type RoomSnapshot, type S2C } from '@dub/shared';
import { Room, type JoinResult } from '../src/room/Room.js';
import { realScheduler } from '../src/room/timers.js';
import type { RoomError, RoomOptions } from '../src/room/types.js';
import { TIMINGS_PRESETS } from '../src/config.js';

const T = TIMINGS_PRESETS.fast;

function clip(id: string, tags: string[] = []): ClipInfo {
  return {
    id,
    title: id,
    url: `/clips/${id}.mp4`,
    durationMs: 8000,
    width: 640,
    height: 360,
    tags,
    attribution: { author: 'a', source: 's', license: 'CC0' },
  };
}

function seeded(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function chunk(id: string, startMs: number, durationMs = 1000): ChunkMeta {
  return { id, startMs, durationMs, offsetMs: 20, mime: 'audio/webm;codecs=opus', bytes: 500 };
}

function ok<T extends object>(r: T | RoomError): T {
  if ('code' in r && 'message' in r && !('playerId' in r))
    throw new Error(`${r.code}: ${r.message}`);
  return r as T;
}

interface Harness {
  room: Room;
  inbox: Map<string, S2C[]>;
  uploaded: Set<string>;
  removed: string[];
  snap(id: string): RoomSnapshot;
  add(name: string): string;
  readyAll(): void;
  upload(id: string, chunkId: string): void;
}

function setup(
  opts: Partial<RoomOptions> = {},
  clips: ClipInfo[] = [clip('a'), clip('b'), clip('c'), clip('d')],
  kind: 'private' | 'public' = 'private',
): Harness {
  const inbox = new Map<string, S2C[]>();
  const uploaded = new Set<string>();
  const removed: string[] = [];
  const room = new Room({
    code: 'ABCDEF',
    clock: { now: () => Date.now() },
    scheduler: realScheduler,
    emit: (id, m) => {
      if (!inbox.has(id)) inbox.set(id, []);
      inbox.get(id)!.push(m);
    },
    clips,
    timings: { ...T },
    options: { allowSolo: false, allowShortDubbing: true, maxPlayers: 8, limits: LIMITS, ...opts },
    isUploaded: (s, c) => uploaded.has(`${s}/${c}`),
    onPlayerRemoved: (id) => removed.push(id),
    rng: seeded(),
    kind,
  });
  const h: Harness = {
    room,
    inbox,
    uploaded,
    removed,
    snap(id) {
      const s = room.snapshotFor(id);
      if (!s) throw new Error(`no snapshot for ${id}`);
      return s;
    },
    add(name) {
      const j = ok<JoinResult>(kind === 'public' ? room.seat(name) : room.join(name));
      expect(room.connect(j.playerId)).toBeNull();
      return j.playerId;
    },
    readyAll() {
      for (const id of room.playerIds()) {
        expect(room.handle(id, { t: 'micStatus', ok: true })).toBeNull();
        expect(room.handle(id, { t: 'setReady', ready: true })).toBeNull();
      }
    },
    upload(id, chunkId) {
      const sub = h.snap(id).you.submissionId!;
      uploaded.add(`${sub}/${chunkId}`);
    },
  };
  return h;
}

function lastState(h: Harness, id: string): RoomSnapshot | undefined {
  const msgs = h.inbox.get(id) ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.t === 'state') return m.state;
  }
  return undefined;
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('lobby', () => {
  it('first player is host; snapshots are pushed with increasing rev', () => {
    const h = setup();
    const a = h.add('Ann');
    const b = h.add('Bob');
    const s = lastState(h, a)!;
    expect(s.hostId).toBe(a);
    expect(s.players.map((p) => p.name)).toEqual(['Ann', 'Bob']);
    expect(s.round).toBe(-1);
    expect(s.phase).toBe('LOBBY');
    expect(lastState(h, b)!.you.playerId).toBe(b);
    expect(lastState(h, b)!.rev).toBeGreaterThan(1);
  });

  it('duplicate names get a suffix', () => {
    const h = setup();
    h.add('Ann');
    const b = h.add('Ann');
    expect(h.snap(b).players[1]!.name).toBe('Ann 2');
  });

  it('ready requires mic; mic loss clears ready', () => {
    const h = setup();
    const a = h.add('Ann');
    expect(h.room.handle(a, { t: 'setReady', ready: true })?.code).toBe('INVALID');
    h.room.handle(a, { t: 'micStatus', ok: true });
    expect(h.room.handle(a, { t: 'setReady', ready: true })).toBeNull();
    expect(h.snap(a).players[0]!.ready).toBe(true);
    h.room.handle(a, { t: 'micStatus', ok: false });
    expect(h.snap(a).players[0]!.ready).toBe(false);
  });

  it('settings: host only, normal forces 3/210, changes clear ready', () => {
    const h = setup();
    const a = h.add('Ann');
    const b = h.add('Bob');
    h.readyAll();
    expect(h.room.handle(b, { t: 'updateSettings', settings: { mode: 'extended' } })?.code).toBe(
      'NOT_HOST',
    );
    expect(
      h.room.handle(a, {
        t: 'updateSettings',
        settings: { mode: 'extended', rounds: 2, dubbingSeconds: 75 },
      }),
    ).toBeNull();
    expect(h.snap(a).settings).toEqual({
      mode: 'extended',
      rounds: 2,
      dubbingSeconds: 75,
      tags: [],
    });
    expect(h.snap(a).players.every((p) => !p.ready)).toBe(true);
    expect(
      h.room.handle(a, { t: 'updateSettings', settings: { mode: 'normal', rounds: 7 } }),
    ).toBeNull();
    expect(h.snap(a).settings).toEqual({
      mode: 'normal',
      rounds: 3,
      dubbingSeconds: 210,
      tags: [],
    });
  });

  it('settings validation: step, range, unknown tags, short dubbing flag', () => {
    const h = setup({ allowShortDubbing: false }, [clip('a', ['x']), clip('b', ['y'])]);
    const a = h.add('Ann');
    const bad = (s: object) =>
      h.room.handle(a, { t: 'updateSettings', settings: { mode: 'extended', ...s } })?.code;
    expect(bad({ dubbingSeconds: 70 })).toBe('INVALID');
    expect(bad({ dubbingSeconds: 10 })).toBe('INVALID');
    expect(bad({ rounds: 11 })).toBe('INVALID');
    expect(bad({ tags: ['zzz'] })).toBe('INVALID');
    expect(bad({ tags: ['x'], rounds: 1 })).toBeUndefined();
    expect(h.snap(a).clipCount).toBe(1);
    expect(h.snap(a).availableTags).toEqual(['x', 'y']);
  });

  it('start blockers: players, mic, ready, clip count; ALLOW_SOLO', () => {
    const h = setup({}, [clip('a'), clip('b')]);
    const a = h.add('Ann');
    let you = h.snap(a).you;
    expect(you.canStart).toBe(false);
    expect(you.startBlockers.join('|')).toMatch(/at least 2 players/);
    expect(you.startBlockers.join('|')).toMatch(/mic check/);
    // V14: 2 clips are enough for 1 player over 3 rounds (clips are reused when they run out).
    expect(you.startBlockers.join('|')).not.toMatch(/clip/);
    expect(h.room.handle(a, { t: 'startGame' })?.code).toBe('START_BLOCKED');
    h.add('Bob');
    h.add('Cid');
    expect(h.snap(a).you.startBlockers.join('|')).toMatch(/only 2 clips for 3 players/);

    const solo = setup({ allowSolo: true });
    const s = solo.add('Solo');
    solo.readyAll();
    you = solo.snap(s).you;
    expect(you.startBlockers).toEqual([]);
    expect(you.canStart).toBe(true);
    expect(solo.room.handle(s, { t: 'startGame' })).toBeNull();
    expect(solo.snap(s).phase).toBe('DUBBING');
  });

  it('non-host cannot start; canStart is host only', () => {
    const h = setup();
    const a = h.add('Ann');
    const b = h.add('Bob');
    h.readyAll();
    expect(h.snap(a).you.canStart).toBe(true);
    expect(h.snap(b).you.canStart).toBe(false);
    expect(h.room.handle(b, { t: 'startGame' })?.code).toBe('NOT_HOST');
  });

  it('kick removes the player and notifies them', () => {
    const h = setup();
    const a = h.add('Ann');
    const b = h.add('Bob');
    expect(h.room.handle(b, { t: 'kick', playerId: a })?.code).toBe('NOT_HOST');
    expect(h.room.handle(a, { t: 'kick', playerId: a })?.code).toBe('INVALID');
    expect(h.room.handle(a, { t: 'kick', playerId: b })).toBeNull();
    expect(h.inbox.get(b)!.at(-1)).toEqual({ t: 'kicked' });
    expect(h.room.hasPlayer(b)).toBe(false);
    expect(h.removed).toEqual([b]);
  });

  it('join fails with ROOM_FULL and GAME_IN_PROGRESS', () => {
    const h = setup({ maxPlayers: 2 });
    h.add('A');
    h.add('B');
    expect(h.room.join('C')).toMatchObject({ code: 'ROOM_FULL' });
    const g = setup();
    g.add('A');
    g.add('B');
    g.readyAll();
    g.room.handle(g.room.host, { t: 'startGame' });
    expect(g.room.join('C')).toMatchObject({ code: 'GAME_IN_PROGRESS' });
  });

  it('lobby drop after lobbyDropMs; host passes on', () => {
    const h = setup();
    const a = h.add('Ann');
    const b = h.add('Bob');
    h.room.disconnect(a);
    vi.advanceTimersByTime(T.lobbyDropMs - 1);
    expect(h.room.hasPlayer(a)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(h.room.hasPlayer(a)).toBe(false);
    expect(h.snap(b).hostId).toBe(b);
  });

  it('reconnect before lobby drop keeps the player', () => {
    const h = setup();
    const a = h.add('Ann');
    h.add('Bob');
    h.room.disconnect(a);
    vi.advanceTimersByTime(T.lobbyDropMs / 2);
    h.room.connect(a);
    vi.advanceTimersByTime(T.lobbyDropMs);
    expect(h.room.hasPlayer(a)).toBe(true);
  });

  it('host migrates to the earliest-joined connected player after hostMigrateMs', () => {
    const h = setup();
    const a = h.add('Ann');
    const b = h.add('Bob');
    const c = h.add('Cid');
    h.readyAll();
    h.room.handle(a, { t: 'startGame' });
    h.room.disconnect(a);
    vi.advanceTimersByTime(T.hostMigrateMs - 1);
    expect(h.room.host).toBe(a);
    vi.advanceTimersByTime(1);
    expect(h.room.host).toBe(b);
    expect(h.snap(c).players.find((p) => p.id === b)!.isHost).toBe(true);
    // in-game disconnect does not remove
    expect(h.room.hasPlayer(a)).toBe(true);
  });

  it('leave in lobby removes; token auth', () => {
    const h = setup();
    const j = ok<JoinResult>(h.room.join('Ann'));
    expect(h.room.authenticate(j.token)).toBe(j.playerId);
    expect(h.room.authenticate('nope')).toBeNull();
    h.room.connect(j.playerId);
    h.room.leave(j.playerId);
    expect(h.room.hasPlayer(j.playerId)).toBe(false);
    expect(h.room.authenticate(j.token)).toBeNull();
    expect(h.room.emptySince).not.toBeNull();
  });
});

/** Starts a 3-player normal game; returns ids. */
function start3(h: Harness): [string, string, string] {
  const a = h.add('Ann');
  const b = h.add('Bob');
  const c = h.add('Cid');
  h.readyAll();
  expect(h.room.handle(a, { t: 'startGame' })).toBeNull();
  return [a, b, c];
}

/** Advances through LOADING → PLAYING → LOCKED of the current item with given votes. */
function playItem(h: Harness, ids: string[], votes: Record<string, number>) {
  const s = h.snap(ids[0]!);
  const item = s.showcase!;
  expect(item.status).toBe('LOADING');
  for (const id of ids) h.room.handle(id, { t: 'preloaded', submissionId: item.submissionId });
  const playing = h.snap(ids[0]!).showcase!;
  expect(playing.status).toBe('PLAYING');
  for (const [id, score] of Object.entries(votes)) {
    expect(h.room.handle(id, { t: 'vote', submissionId: item.submissionId, score })).toBeNull();
  }
  vi.advanceTimersByTime(playing.lockAt! - Date.now());
  expect(h.snap(ids[0]!).showcase!.status).toBe('LOCKED');
  vi.advanceTimersByTime(T.betweenItemsMs);
  return item.submissionId;
}

describe('full 3-player game', () => {
  it('goes through every phase and scores', () => {
    const h = setup();
    const ids = start3(h);
    const [a, b, c] = ids;
    const clipsSeen: string[] = [];
    const clipsOf = new Map<string, string[]>(ids.map((id) => [id, []]));

    for (let round = 0; round < 3; round++) {
      let s = h.snap(a);
      expect(s.phase).toBe('DUBBING');
      expect(s.round).toBe(round);
      expect(s.totalRounds).toBe(3);
      expect(s.phaseEndsAt).toBe(Date.now() + 210_000);
      // V14: every player dubs a different clip, and never one they already had.
      expect(s).not.toHaveProperty('clip');
      const dealt = ids.map((id) => h.snap(id).you.clip!.id);
      expect(new Set(dealt).size).toBe(3);
      ids.forEach((id, i) => clipsOf.get(id)!.push(dealt[i]!));
      clipsSeen.push(...dealt);
      const subs = Object.fromEntries(ids.map((id) => [id, h.snap(id).you.submissionId!]));
      expect(new Set(Object.values(subs)).size).toBe(3);

      // a and b dub, c stays empty
      for (const id of [a, b]) {
        const ch = [chunk(`${id}-1`, 2000), chunk(`${id}-0`, 0)];
        expect(h.room.handle(id, { t: 'manifest', round, chunks: ch })).toBeNull();
        for (const k of ch) h.upload(id, k.id);
      }
      // b lists a chunk it never uploaded → dropped at finalize
      h.room.handle(b, {
        t: 'manifest',
        round,
        chunks: [chunk(`${b}-0`, 0), chunk(`${b}-1`, 2000), chunk('ghost', 4000)],
      });
      expect(h.snap(a).you.manifest.map((x) => x.id)).toEqual([`${a}-0`, `${a}-1`]);
      expect(h.snap(b).you.uploaded).toEqual([`${b}-0`, `${b}-1`]);

      for (const id of ids) h.room.handle(id, { t: 'dubDone', round, done: true });
      s = h.snap(a);
      expect(s.phase).toBe('DUBBING'); // upload grace
      expect(
        h.room.handle(a, {
          t: 'manifest',
          round,
          chunks: [chunk(`${a}-0`, 0), chunk(`${a}-1`, 2000)],
        }),
      ).toBeNull();
      vi.advanceTimersByTime(T.uploadGraceMs);

      s = h.snap(a);
      expect(s.phase).toBe('SHOWCASE');
      expect(s.showcase!.total).toBe(2);
      // first item
      const first = s.showcase!;
      const author1 = first.submissionId === subs[a] ? a : b;
      const other1 = author1 === a ? b : a;
      expect(h.snap(author1).you.isOwnItem).toBe(true);
      expect(h.snap(other1).you.isOwnItem).toBe(false);
      expect(first.chunks.map((x) => x.id)).toEqual([`${author1}-0`, `${author1}-1`]);
      expect(first.clip).toEqual(h.snap(author1).you.clip);
      expect(h.snap(author1).you.clip).not.toEqual(h.snap(other1).you.clip);
      expect(first.chunks[0]!.url).toBe(
        `/api/rooms/ABCDEF/rounds/${round}/subs/${first.submissionId}/chunks/${author1}-0`,
      );
      if (author1 === b) expect(first.chunks.some((x) => x.id === 'ghost')).toBe(false);
      playItem(h, ids, { [other1]: 8, [c]: 6 });
      // second item: nobody votes → neutral 50
      const second = h.snap(a).showcase!;
      expect(second.index).toBe(1);
      playItem(h, ids, {});

      s = h.snap(a);
      expect(s.phase).toBe('ROUND_RESULTS');
      const rr = s.roundResult!;
      expect(rr.round).toBe(round);
      const by = Object.fromEntries(rr.entries.map((e) => [e.playerId, e]));
      expect(by[author1]).toMatchObject({ points: 70, votes: 2, avg: 7, empty: false });
      expect(by[other1]).toMatchObject({ points: 50, votes: 0, avg: null });
      expect(by[c]).toMatchObject({ points: 0, empty: true });
      for (const id of ids) expect(by[id]!.clip).toEqual(h.snap(id).you.clip);
      expect(s.phaseEndsAt).toBe(Date.now() + T.roundResultsMs);

      if (round === 0) {
        // non-host cannot advance; host can skip
        expect(h.room.handle(b, { t: 'advance' })?.code).toBe('NOT_HOST');
        expect(h.room.handle(a, { t: 'advance' })).toBeNull();
      } else {
        vi.advanceTimersByTime(T.roundResultsMs); // auto-advance
      }
    }

    for (const mine of clipsOf.values()) expect(new Set(mine).size).toBe(3);
    expect(new Set(clipsSeen).size).toBe(4); // every clip of the library got used
    const s = h.snap(c);
    expect(s.phase).toBe('FINAL');
    const f = s.final!;
    const totals = Object.fromEntries(s.players.map((p) => [p.id, p.totalScore]));
    expect(totals[c]).toBe(0);
    expect(totals[a]! + totals[b]!).toBe(3 * 120);
    expect(f.standings).toHaveLength(3);
    expect(f.winners.length).toBeGreaterThanOrEqual(1);
    expect(f.bestDub?.chunks.length).toBe(2);
    expect(clipsOf.get(f.bestDub!.playerId)![f.bestDub!.round]).toBe(f.bestDub!.clip.id);
    expect(f.winners).not.toContain(c);

    // back to lobby: scores reset, used clips kept
    expect(h.room.handle(b, { t: 'backToLobby' })?.code).toBe('NOT_HOST');
    expect(h.room.handle(a, { t: 'backToLobby' })).toBeNull();
    const lobby = h.snap(a);
    expect(lobby.phase).toBe('LOBBY');
    expect(lobby.round).toBe(-1);
    expect(lobby.players.every((p) => p.totalScore === 0 && !p.ready)).toBe(true);
    expect(lobby.clipCount).toBe(4); // V14: the whole library; history only steers the deal
    expect(lobby.you.startBlockers.join()).not.toMatch(/clip/);
    h.room.handle(a, { t: 'updateSettings', settings: { mode: 'extended', rounds: 1 } });
    h.readyAll();
    expect(h.room.handle(a, { t: 'startGame' })).toBeNull();
    // History survives backToLobby: the least recently used clips come first, still distinct.
    const again = ids.map((id) => h.snap(id).you.clip!.id);
    expect(new Set(again).size).toBe(3);
  });
});

describe('dubbing rules', () => {
  it("V14: manifests and lockAt use each player's own clip duration", () => {
    const short = { ...clip('s'), durationMs: 3000 };
    const long = { ...clip('l'), durationMs: 9000 };
    const h = setup({}, [short, long]);
    const a = h.add('Ann');
    const b = h.add('Bob');
    h.readyAll();
    h.room.handle(a, { t: 'updateSettings', settings: { mode: 'extended', rounds: 1 } });
    h.readyAll();
    expect(h.room.handle(a, { t: 'startGame' })).toBeNull();
    const [s, l] = [a, b].sort(
      (x, y) => h.snap(x).you.clip!.durationMs - h.snap(y).you.clip!.durationMs,
    );
    expect(h.snap(s!).you.clip!.id).toBe('s');
    expect(h.snap(l!).you.clip!.id).toBe('l');
    const late = [chunk('late', 5000)];
    expect(h.room.handle(s!, { t: 'manifest', round: 0, chunks: late })?.code).toBe('INVALID');
    expect(h.room.handle(l!, { t: 'manifest', round: 0, chunks: late })).toBeNull();
    h.upload(l!, 'late');
    for (const id of [a, b]) h.room.handle(id, { t: 'dubDone', round: 0, done: true });
    vi.advanceTimersByTime(T.uploadGraceMs);
    const item = h.snap(a).showcase!;
    expect(item.clip.id).toBe('l');
    for (const id of [a, b]) h.room.handle(id, { t: 'preloaded', submissionId: item.submissionId });
    const playing = h.snap(a).showcase!;
    expect(playing.lockAt! - playing.startAt!).toBe(9000 + T.voteGraceMs);
  });

  it('deadline closes dubbing, then grace, then showcase', () => {
    const h = setup();
    const [a, b] = start3(h);
    h.room.handle(a, { t: 'manifest', round: 0, chunks: [chunk('x', 0)] });
    h.upload(a, 'x');
    vi.advanceTimersByTime(210_000);
    expect(h.snap(a).phase).toBe('DUBBING');
    expect(h.room.uploadTarget(a, 0)).toHaveProperty('submissionId'); // grace still allows uploads
    vi.advanceTimersByTime(T.uploadGraceMs);
    expect(h.snap(a).phase).toBe('SHOWCASE');
    expect(h.room.uploadTarget(a, 0)).toMatchObject({ code: 'BAD_PHASE' });
    expect(h.snap(b).showcase!.total).toBe(1);
  });

  it('no non-empty submissions → straight to ROUND_RESULTS', () => {
    const h = setup();
    const ids = start3(h);
    for (const id of ids) h.room.handle(id, { t: 'dubDone', round: 0, done: true });
    vi.advanceTimersByTime(T.uploadGraceMs);
    const s = h.snap(ids[0]);
    expect(s.phase).toBe('ROUND_RESULTS');
    expect(s.roundResult!.entries.every((e) => e.empty && e.points === 0)).toBe(true);
  });

  it('dubDone early end only counts connected players; un-done blocks', () => {
    const h = setup();
    const [a, b, c] = start3(h);
    h.room.handle(a, { t: 'dubDone', round: 0, done: true });
    h.room.handle(b, { t: 'dubDone', round: 0, done: true });
    h.room.handle(b, { t: 'dubDone', round: 0, done: false });
    h.room.handle(b, { t: 'dubDone', round: 0, done: true });
    vi.advanceTimersByTime(T.uploadGraceMs * 2);
    expect(h.snap(a).phase).toBe('DUBBING');
    expect(h.snap(a).phaseEndsAt).toBeGreaterThan(Date.now() + 100_000);
    h.room.disconnect(c);
    expect(h.snap(a).phaseEndsAt).toBe(Date.now());
  });

  it('manifest rules: wrong round, invalid, LOBBY', () => {
    const h = setup();
    const a = h.add('Ann');
    expect(h.room.handle(a, { t: 'manifest', round: 0, chunks: [] })?.code).toBe('BAD_PHASE');
    h.add('Bob');
    h.readyAll();
    h.room.handle(a, { t: 'startGame' });
    expect(h.room.handle(a, { t: 'manifest', round: 1, chunks: [] })?.code).toBe('BAD_PHASE');
    expect(h.room.handle(a, { t: 'manifest', round: 0, chunks: [chunk('x', 9000)] })?.code).toBe(
      'INVALID',
    );
    expect(
      h.room.handle(a, { t: 'manifest', round: 0, chunks: [chunk('x', 0), chunk('x', 10)] })?.code,
    ).toBe('INVALID');
  });

  it('disconnect/reconnect mid-DUBBING keeps the manifest and submission', () => {
    const h = setup();
    const [a, b] = start3(h);
    const sub = h.snap(a).you.submissionId;
    h.room.handle(a, { t: 'manifest', round: 0, chunks: [chunk('k1', 100), chunk('k2', 3000)] });
    h.upload(a, 'k1');
    h.room.disconnect(a);
    expect(h.snap(b).players.find((p) => p.id === a)!.connected).toBe(false);
    vi.advanceTimersByTime(T.lobbyDropMs + 1); // no drop during a game
    // dubbing deadline 210s has not passed yet (61s)
    expect(h.room.hasPlayer(a)).toBe(true);
    h.inbox.set(a, []);
    h.room.connect(a);
    const s = lastState(h, a)!;
    expect(s.phase).toBe('DUBBING');
    expect(s.you.submissionId).toBe(sub);
    expect(s.you.manifest.map((x) => x.id)).toEqual(['k1', 'k2']);
    expect(s.you.uploaded).toEqual(['k1']);
  });

  it('upload / download permissions', () => {
    const h = setup();
    const [a, b] = start3(h);
    const subA = h.snap(a).you.submissionId!;
    expect(h.room.uploadTarget(a, 1)).toMatchObject({ code: 'BAD_PHASE' });
    expect(h.room.uploadTarget('nobody', 0)).toMatchObject({ code: 'BAD_TOKEN' });
    expect(h.room.canDownload(a, 0, subA)).toBeNull();
    expect(h.room.canDownload(b, 0, subA)).toMatchObject({ code: 'BAD_PHASE' });
    expect(h.room.canDownload(b, 0, 'nope')).toMatchObject({ code: 'INVALID' });
    for (const id of h.room.playerIds()) h.room.handle(id, { t: 'dubDone', round: 0, done: true });
    vi.advanceTimersByTime(T.uploadGraceMs);
    expect(h.room.canDownload(b, 0, subA)).toBeNull();
  });
});

describe('showcase & voting rules', () => {
  function toShowcase() {
    const h = setup();
    const ids = start3(h);
    ids.forEach((id, i) => {
      h.room.handle(id, { t: 'manifest', round: 0, chunks: [chunk(`k${i}`, 0)] });
      h.upload(id, `k${i}`);
      h.room.handle(id, { t: 'dubDone', round: 0, done: true });
    });
    vi.advanceTimersByTime(T.uploadGraceMs);
    return { h, ids };
  }

  it('vote only while PLAYING; self-vote rejected; vote after lock rejected; last vote counts', () => {
    const { h, ids } = toShowcase();
    const item = h.snap(ids[0]).showcase!;
    const subs = Object.fromEntries(ids.map((id) => [id, h.snap(id).you.submissionId]));
    const author = ids.find((id) => subs[id] === item.submissionId)!;
    const voter = ids.find((id) => id !== author)!;
    expect(
      h.room.handle(voter, { t: 'vote', submissionId: item.submissionId, score: 5 })?.code,
    ).toBe('BAD_PHASE');
    vi.advanceTimersByTime(T.preloadMaxMs); // preload timeout → PLAYING
    const playing = h.snap(voter).showcase!;
    expect(playing.status).toBe('PLAYING');
    expect(playing.startAt).toBe(Date.now() + T.playLeadMs);
    expect(playing.lockAt).toBe(playing.startAt! + 8000 + T.voteGraceMs);
    expect(playing.votersExpected).toBe(2);
    expect(
      h.room.handle(author, { t: 'vote', submissionId: item.submissionId, score: 10 })?.code,
    ).toBe('SELF_VOTE');
    expect(h.room.handle(voter, { t: 'vote', submissionId: 'other', score: 3 })?.code).toBe(
      'BAD_PHASE',
    );
    expect(
      h.room.handle(voter, { t: 'vote', submissionId: item.submissionId, score: 2 }),
    ).toBeNull();
    expect(
      h.room.handle(voter, { t: 'vote', submissionId: item.submissionId, score: 9 }),
    ).toBeNull();
    expect(
      h.inbox
        .get(voter)!
        .filter((m) => m.t === 'voteAck')
        .at(-1),
    ).toEqual({
      t: 'voteAck',
      submissionId: item.submissionId,
      score: 9,
    });
    expect(h.snap(voter).you.vote).toBe(9);
    expect(h.snap(author).you.isOwnItem).toBe(true);
    expect(h.snap(voter).showcase!.votesCast).toBe(1);
    vi.advanceTimersByTime(playing.lockAt! - Date.now());
    expect(h.snap(voter).showcase!.status).toBe('LOCKED');
    expect(
      h.room.handle(voter, { t: 'vote', submissionId: item.submissionId, score: 1 })?.code,
    ).toBe('BAD_PHASE');
    // run the rest to results and check the counted vote
    vi.advanceTimersByTime(T.betweenItemsMs);
    for (let i = 1; i < 3; i++) {
      vi.advanceTimersByTime(T.preloadMaxMs);
      const p = h.snap(voter).showcase!;
      vi.advanceTimersByTime(p.lockAt! - Date.now() + T.betweenItemsMs);
    }
    const rr = h.snap(voter).roundResult!;
    expect(rr.entries.find((e) => e.submissionId === item.submissionId)).toMatchObject({
      points: 90,
      votes: 1,
    });
  });

  it('all connected preloaded → plays early; a disconnected player does not block', () => {
    const { h, ids } = toShowcase();
    const item = h.snap(ids[0]).showcase!;
    h.room.disconnect(ids[2]);
    h.room.handle(ids[0], { t: 'preloaded', submissionId: item.submissionId });
    expect(h.snap(ids[0]).showcase!.status).toBe('LOADING');
    h.room.handle(ids[1], { t: 'preloaded', submissionId: item.submissionId });
    expect(h.snap(ids[0]).showcase!.status).toBe('PLAYING');
    expect(h.room.handle(ids[1], { t: 'preloaded', submissionId: item.submissionId })?.code).toBe(
      'BAD_PHASE',
    );
  });

  it('snapshots during showcase do not reveal authors', () => {
    const { h, ids } = toShowcase();
    const s = h.snap(ids[0]);
    expect(JSON.stringify(s.showcase)).not.toContain(ids[1]);
    expect(JSON.stringify(s.showcase)).not.toContain(ids[2]);
  });
});

describe('voice opt-in (V13)', () => {
  it('private rooms: everyone may signal, no voiceOptIn field', () => {
    const h = setup();
    const a = h.add('A');
    const b = h.add('B');
    expect(h.room.voicePeers(a, b)).toBe(true);
    expect(h.snap(a).players[0]).not.toHaveProperty('voiceOptIn');
  });

  it('public rooms: only two opted-in players may signal', () => {
    const h = setup({}, undefined, 'public');
    const a = h.add('A');
    const b = h.add('B');
    const c = h.add('C');
    expect(h.room.voicePeers(a, b)).toBe(false);
    expect(h.room.handle(a, { t: 'voiceOptIn', on: true })).toBeNull();
    expect(h.room.voicePeers(a, b)).toBe(false);
    expect(h.room.handle(b, { t: 'voiceOptIn', on: true })).toBeNull();
    expect(h.room.voicePeers(a, b)).toBe(true);
    expect(h.room.voicePeers(a, c)).toBe(false);
    expect(h.snap(c).players.map((p) => p.voiceOptIn)).toEqual([true, true, false]);
    h.room.handle(a, { t: 'voiceOptIn', on: false });
    expect(h.room.voicePeers(a, b)).toBe(false);
  });
});
