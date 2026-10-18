import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIMITS,
  MAX_BOTS,
  type C2S,
  type ClipInfo,
  type PlayerId,
  type RoomSnapshot,
  type S2C,
} from '@dub/shared';
import { BotPlayer, BOT, type BotSound } from '../src/bots/BotPlayer.js';
import { loadSoundPool } from '../src/bots/sounds.js';
import { Room } from '../src/room/Room.js';
import { realScheduler } from '../src/room/timers.js';
import type { RoomOptions } from '../src/room/types.js';
import { TIMINGS_PRESETS } from '../src/config.js';

const T = TIMINGS_PRESETS.fast;
const CLIP_MS = 8000;

function clip(id: string): ClipInfo {
  return {
    id,
    title: id,
    url: `/clips/${id}.mp4`,
    durationMs: CLIP_MS,
    width: 640,
    height: 360,
    tags: [],
    attribution: { author: 'a', source: 's', license: 'CC0' },
  };
}

function seeded(seed = 7) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const SOUNDS: BotSound[] = [600, 1500, 2500].map((ms, i) => ({
  name: `s${i}`,
  durationMs: ms,
  mime: 'audio/webm;codecs=opus',
  data: Buffer.alloc(100 + i, i),
}));

function setup(opts: Partial<RoomOptions> = { devBots: true }, sounds = SOUNDS) {
  const human = new Map<PlayerId, S2C[]>();
  const bots = new Map<PlayerId, BotPlayer>();
  const sent = new Map<PlayerId, C2S[]>();
  const uploaded = new Map<string, Buffer>();
  const rng = seeded();
  let room!: Room;
  // Record what bots send, then forward to the room (spy on the Room API they drive).
  const botRoom = {
    handle: (id: PlayerId, msg: C2S) => {
      if (!sent.has(id)) sent.set(id, []);
      sent.get(id)!.push(msg);
      return room.handle(id, msg);
    },
    uploadTarget: (id: PlayerId, round: number) => room.uploadTarget(id, round),
  };
  room = new Room({
    code: 'ABCDEF',
    clock: { now: () => Date.now() },
    scheduler: realScheduler,
    emit: (id, m) => {
      const bot = bots.get(id);
      if (bot) bot.send(m);
      else {
        if (!human.has(id)) human.set(id, []);
        human.get(id)!.push(m);
      }
    },
    clips: [clip('a'), clip('b'), clip('c'), clip('d')], // V14: one clip per player
    timings: { ...T },
    options: { allowSolo: false, allowShortDubbing: true, maxPlayers: 8, limits: LIMITS, ...opts },
    isUploaded: (s, c) => uploaded.has(`${s}/${c}`),
    onBotAdded: (id) =>
      bots.set(
        id,
        new BotPlayer({
          room: botRoom,
          playerId: id,
          clock: { now: () => Date.now() },
          scheduler: realScheduler,
          sounds,
          put: async (_round, sub, chunk, _mime, data) => {
            await Promise.resolve();
            uploaded.set(`${sub}/${chunk}`, data);
          },
          rng,
        }),
      ),
    onPlayerRemoved: (id) => {
      bots.get(id)?.close();
      bots.delete(id);
    },
    rng,
  });
  const join = (name: string): PlayerId => {
    const j = room.join(name);
    if ('code' in j) throw new Error(j.message);
    room.connect(j.playerId);
    return j.playerId;
  };
  const snap = (id: PlayerId): RoomSnapshot => room.snapshotFor(id)!;
  return { room, bots, sent, uploaded, join, snap, human };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('bot management', () => {
  it('only with devBots, only the host', () => {
    const off = setup({ devBots: false });
    const a0 = off.join('Ann');
    expect(off.snap(a0).you.canManageBots).toBe(false);
    expect(off.room.handle(a0, { t: 'addBot' })?.code).toBe('INVALID');

    const h = setup();
    const a = h.join('Ann');
    const b = h.join('Bob');
    expect(h.snap(a).you.canManageBots).toBe(true);
    expect(h.snap(b).you.canManageBots).toBe(false);
    expect(h.room.handle(b, { t: 'addBot' })?.code).toBe('NOT_HOST');
    expect(h.room.handle(a, { t: 'addBot' })).toBeNull();
    const bot = h.snap(a).players.find((p) => p.isBot)!;
    expect(bot).toMatchObject({ isBot: true, connected: true, isHost: false });
    expect(h.snap(a).players.find((p) => p.id === a)!.isBot).toBe(false);
  });

  it('caps at MAX_BOTS / room size; removeBot removes the last bot or a given one', () => {
    const h = setup();
    const a = h.join('Ann');
    for (let i = 0; i < MAX_BOTS; i++) expect(h.room.handle(a, { t: 'addBot' })).toBeNull();
    expect(h.room.handle(a, { t: 'addBot' })?.code).toBe('LIMIT');
    const ids = h
      .snap(a)
      .players.filter((p) => p.isBot)
      .map((p) => p.id);
    expect(new Set(h.snap(a).players.map((p) => p.name)).size).toBe(8);
    expect(h.room.handle(a, { t: 'removeBot' })).toBeNull();
    expect(h.room.hasPlayer(ids.at(-1)!)).toBe(false);
    expect(h.room.handle(a, { t: 'removeBot', playerId: ids[0] })).toBeNull();
    expect(h.room.hasPlayer(ids[0]!)).toBe(false);
    expect(h.room.handle(a, { t: 'removeBot', playerId: a })?.code).toBe('INVALID');
    expect(h.bots.size).toBe(MAX_BOTS - 2);
  });

  it('bots never become host and leave with the last human; they do not keep a room alive', () => {
    const h = setup();
    const a = h.join('Ann');
    h.room.handle(a, { t: 'addBot' });
    h.room.handle(a, { t: 'addBot' });
    expect(h.room.connectedCount).toBe(1);
    h.room.disconnect(a);
    expect(h.room.emptySince).not.toBeNull();
    h.room.leave(a);
    expect(h.room.playerCount).toBe(0);
    expect(h.bots.size).toBe(0);
  });

  it('bots set micOk and ready by themselves (again after a settings change)', async () => {
    const h = setup();
    const a = h.join('Ann');
    h.room.handle(a, { t: 'addBot' });
    h.room.handle(a, { t: 'addBot' });
    await vi.advanceTimersByTimeAsync(BOT.micDelayMs[1] + BOT.readyDelayMs[1] + 10);
    const bots = () => h.snap(a).players.filter((p) => p.isBot);
    expect(bots().every((p) => p.micOk && p.ready)).toBe(true);
    h.room.handle(a, { t: 'updateSettings', settings: { mode: 'extended', rounds: 1 } });
    expect(bots().some((p) => p.ready)).toBe(false);
    await vi.advanceTimersByTimeAsync(BOT.readyDelayMs[1] + 10);
    expect(bots().every((p) => p.ready)).toBe(true);
    // A solo human + bots may start without ALLOW_SOLO.
    h.room.handle(a, { t: 'micStatus', ok: true });
    h.room.handle(a, { t: 'setReady', ready: true });
    expect(h.snap(a).you.startBlockers).toEqual([]);
  });
});

describe('bot game', () => {
  it('dubs 3–6 uploaded chunks, preloads, votes 3–9 before lock, to FINAL', async () => {
    const h = setup();
    const a = h.join('Ann');
    for (let i = 0; i < 3; i++) h.room.handle(a, { t: 'addBot' });
    h.room.handle(a, {
      t: 'updateSettings',
      settings: { mode: 'extended', rounds: 2, dubbingSeconds: 60 },
    });
    h.room.handle(a, { t: 'micStatus', ok: true });
    h.room.handle(a, { t: 'setReady', ready: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.room.handle(a, { t: 'startGame' })).toBeNull();
    const botIds = [...h.bots.keys()];

    for (let round = 0; round < 2; round++) {
      expect(h.snap(a)).toMatchObject({ phase: 'DUBBING', round });
      // V14: bots get their own clips too, distinct from everyone else's.
      expect(new Set([a, ...botIds].map((id) => h.snap(id).you.clip!.id)).size).toBe(4);
      // Bots record within the first seconds of the phase (#47: at most dubEndMs), then Done.
      await vi.advanceTimersByTimeAsync(BOT.dubEndMs + BOT.doneDelayMs[1] + 10);
      expect(
        h
          .snap(a)
          .players.filter((p) => p.isBot)
          .every((p) => p.dubDone),
      ).toBe(true);
      expect(h.snap(a).phase).toBe('DUBBING'); // the human is not done yet
      for (const id of botIds) {
        const s = h.snap(id);
        expect(s.you.manifest.length).toBeGreaterThanOrEqual(BOT.chunks[0]);
        expect(s.you.manifest.length).toBeLessThanOrEqual(BOT.chunks[1]);
        expect(s.you.uploaded).toHaveLength(s.you.manifest.length);
        for (const c of s.you.manifest) {
          expect(c.startMs + c.durationMs).toBeLessThanOrEqual(CLIP_MS);
          expect(c.offsetMs).toBe(0);
          const data = h.uploaded.get(`${s.you.submissionId}/${c.id}`)!;
          expect(SOUNDS.some((x) => x.data.equals(data))).toBe(true);
        }
      }
      h.room.handle(a, { t: 'dubDone', round, done: true });
      await vi.advanceTimersByTimeAsync(T.uploadGraceMs + 1);

      // Showcase: 3 bot dubs (the human's is empty). The human preloads; bots already did.
      for (let item = 0; item < 3; item++) {
        let s = h.snap(a);
        expect(s.phase).toBe('SHOWCASE');
        expect(s.showcase).toMatchObject({ status: 'LOADING', index: item });
        await vi.advanceTimersByTimeAsync(BOT.preloadDelayMs[1] + 1);
        h.room.handle(a, { t: 'preloaded', submissionId: s.showcase!.submissionId });
        s = h.snap(a);
        expect(s.showcase!.status).toBe('PLAYING');
        await vi.advanceTimersByTimeAsync(s.showcase!.lockAt! - Date.now() - 1);
        // Every bot except the author has voted.
        expect(h.snap(a).showcase!.votesCast).toBe(2);
        await vi.advanceTimersByTimeAsync(1 + T.betweenItemsMs);
      }
      const res = h.snap(a);
      expect(res.phase).toBe('ROUND_RESULTS');
      for (const e of res.roundResult!.entries) {
        if (e.playerId === a) expect(e.empty).toBe(true);
        else {
          expect(e.votes).toBe(2);
          expect(e.avg!).toBeGreaterThanOrEqual(BOT.score[0]);
          expect(e.avg!).toBeLessThanOrEqual(BOT.score[1]);
        }
      }
      await vi.advanceTimersByTimeAsync(T.roundResultsMs + 1);
    }
    expect(h.snap(a).phase).toBe('FINAL');
    for (const id of botIds) {
      for (const m of h.sent.get(id)!) {
        if (m.t === 'vote') {
          expect(m.score).toBeGreaterThanOrEqual(3);
          expect(m.score).toBeLessThanOrEqual(9);
        }
      }
    }
    // Back in the lobby the bots get ready again.
    h.room.handle(a, { t: 'backToLobby' });
    await vi.advanceTimersByTimeAsync(BOT.readyDelayMs[1] + 10);
    expect(
      h
        .snap(a)
        .players.filter((p) => p.isBot)
        .every((p) => p.ready),
    ).toBe(true);
  });

  it('#47: long snippets spread over the clip; bots hurry once every human is Done', async () => {
    const long: BotSound[] = [3000, 4000, 5000].map((ms, i) => ({
      name: `l${i}`,
      durationMs: ms,
      mime: 'audio/webm;codecs=opus',
      data: Buffer.alloc(200 + i, i),
    }));
    const h = setup({ devBots: true }, long);
    const a = h.join('Ann');
    for (let i = 0; i < 2; i++) h.room.handle(a, { t: 'addBot' });
    h.room.handle(a, {
      t: 'updateSettings',
      settings: { mode: 'extended', rounds: 1, dubbingSeconds: 210 },
    });
    h.room.handle(a, { t: 'micStatus', ok: true });
    h.room.handle(a, { t: 'setReady', ready: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.room.handle(a, { t: 'startGame' })).toBeNull();
    // The human is done right away: bots record everything now instead of over ~12 s.
    await vi.advanceTimersByTimeAsync(100);
    h.room.handle(a, { t: 'dubDone', round: 0, done: true });
    // Bots record now, press Done, and dubbing closes (upload grace) long before 210 s.
    await vi.advanceTimersByTimeAsync(
      BOT.preloadDelayMs[1] + BOT.doneDelayMs[1] + T.uploadGraceMs + 200,
    );
    expect(h.snap(a).phase).toBe('SHOWCASE');
    for (const id of h.bots.keys()) {
      const last = h.sent
        .get(id)!
        .filter((m) => m.t === 'manifest')
        .at(-1);
      expect(last?.t).toBe('manifest');
      const m = [...(last as Extract<C2S, { t: 'manifest' }>).chunks].sort(
        (x, y) => x.startMs - y.startMs,
      );
      expect(m.length).toBeGreaterThanOrEqual(BOT.chunks[0]);
      expect(m.length).toBeLessThanOrEqual(BOT.chunks[1]);
      for (const c of m) {
        expect(c.durationMs).toBeGreaterThanOrEqual(3000);
        expect(c.startMs).toBeGreaterThanOrEqual(0);
        expect(c.startMs + c.durationMs).toBeLessThanOrEqual(CLIP_MS);
      }
      expect(m[0]!.startMs).toBeLessThan(CLIP_MS / 3);
      expect(m.at(-1)!.startMs + m.at(-1)!.durationMs).toBeGreaterThan((CLIP_MS * 2) / 3);
    }
    // Both bot dubs made it into the showcase.
    expect(h.snap(a).showcase!.total).toBe(2);
  });

  it('with an empty sound pool bots submit empty dubs and still finish', async () => {
    const h = setup({ devBots: true }, []);
    const a = h.join('Ann');
    h.room.handle(a, { t: 'addBot' });
    h.room.handle(a, {
      t: 'updateSettings',
      settings: { mode: 'extended', rounds: 1, dubbingSeconds: 60 },
    });
    h.room.handle(a, { t: 'micStatus', ok: true });
    h.room.handle(a, { t: 'setReady', ready: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.room.handle(a, { t: 'startGame' })).toBeNull();
    await vi.advanceTimersByTimeAsync(BOT.doneDelayMs[1] + 10);
    expect(h.snap(a).players.find((p) => p.isBot)!.dubDone).toBe(true);
    h.room.handle(a, { t: 'dubDone', round: 0, done: true });
    await vi.advanceTimersByTimeAsync(T.uploadGraceMs + 1);
    expect(h.snap(a).phase).toBe('ROUND_RESULTS');
    expect(h.uploaded.size).toBe(0);
  });
});

describe('bot sound pool', () => {
  it('loads <clips>/bot-sounds/manifest.json and skips missing files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dub-bot-sounds-'));
    fs.mkdirSync(path.join(dir, 'bot-sounds'));
    fs.writeFileSync(path.join(dir, 'bot-sounds', 'a.webm'), Buffer.alloc(10, 1));
    fs.writeFileSync(
      path.join(dir, 'bot-sounds', 'manifest.json'),
      JSON.stringify({
        sounds: [
          { file: 'a.webm', durationMs: 900, clipId: 'x', startMs: 0 },
          { file: 'gone.webm', durationMs: 900 },
          { file: '../evil.webm', durationMs: 900 },
        ],
      }),
    );
    const warn = vi.fn();
    const pool = loadSoundPool(dir, warn);
    expect(pool.map((s) => [s.name, s.durationMs, s.data.length])).toEqual([['a.webm', 900, 10]]);
    expect(warn).toHaveBeenCalledOnce();
    expect(loadSoundPool(path.join(dir, 'nope'))).toEqual([]);
  });
});
