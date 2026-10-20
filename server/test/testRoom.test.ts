import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TEST_ROOM_PATH, type TestRoomResponse } from '@dub/shared';
import { buildApp } from '../src/http/app.js';
import { ClipLibrary } from '../src/clips/ClipLibrary.js';
import { JobQueue, hasFfmpeg } from '../src/clips/normalize.js';
import { RoomManager } from '../src/room/RoomManager.js';
import { AUTO_START_MIC_WAIT_MS, type Room } from '../src/room/Room.js';
import type { AnalyticsEvent, Tracker } from '../src/analytics/Analytics.js';
import { LibraryBotSounds, type SoundSourceLibrary } from '../src/bots/librarySounds.js';
import { SNIPPET, SNIPPET_RECIPE } from '../src/bots/snippets.js';
import type { BotSound } from '../src/bots/BotPlayer.js';
import { botSoundKey } from '../src/bots/BotVoice.js';
import { makeClipsDir, testConfig, tmpDir } from './helpers.js';

describe('JobQueue low priority (v1.2 #46)', () => {
  it('runs low jobs after every admin and user job, one low job at a time', async () => {
    const q = new JobQueue(5, 10, 5);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = (n: string, wait?: Promise<void>) => async () => {
      if (wait) await wait;
      order.push(n);
    };
    const first = q.push(job('admin-1', gate));
    expect(q.push(job('low-1'), { priority: 'low' })).not.toBeNull();
    expect(q.push(job('low-2'), { priority: 'low' })).toBeNull(); // one pending low job
    q.push(job('user-1'), { priority: 'user', owner: 'u' });
    q.push(job('admin-2'));
    release();
    await first;
    await q.idle();
    expect(order).toEqual(['admin-1', 'admin-2', 'user-1', 'low-1']);
  });
});

describe('admin test room (v1.2 #46)', () => {
  let app: FastifyInstance;
  let rooms: RoomManager;
  let events: AnalyticsEvent[];

  beforeEach(async () => {
    events = [];
    const tracker: Tracker = {
      track: (e) => void events.push(e),
      unique: (e) => void events.push(e),
    };
    const clips = ClipLibrary.load(makeClipsDir(4));
    // No DEV_BOTS: bots must still work in a test room.
    const config = testConfig({ adminDev: true, devBots: false, allowShortDubbing: false });
    rooms = new RoomManager({
      config,
      clips: clips.clips,
      library: clips,
      analytics: tracker,
      botSounds: async () => [],
    });
    app = await buildApp({ config, clips, rooms });
  });
  afterEach(async () => {
    await app.close();
    await rooms.stop();
  });

  const create = (payload: object, remoteAddress = '127.0.0.1') =>
    app.inject({ method: 'POST', url: TEST_ROOM_PATH, payload, remoteAddress });

  const hostOf = (room: Room) =>
    room.playerIds().find((p) => !room.snapshotFor(p)!.players.find((q) => q.id === p)!.isBot)!;

  it('is admin-only and validates its body', async () => {
    expect((await create({ bots: 3 }, '198.51.100.1')).statusCode).toBe(403);
    expect((await create({ bots: 0 })).statusCode).toBe(400);
    expect((await create({ bots: 8 })).statusCode).toBe(400);
    expect((await create({ bots: 2, dubbingSeconds: 2 })).statusCode).toBe(400);
    expect((await create({ bots: 2, libraryId: 'nope' })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: TEST_ROOM_PATH,
          payload: { bots: 2 },
          headers: { origin: 'https://evil.example' },
        })
      ).statusCode,
    ).toBe(403);
    expect(rooms.size).toBe(0);
  });

  it('creates a private room: admin host + bots, short dubbing, bot controls, no analytics', async () => {
    const res = await create({
      bots: 3,
      rounds: 1,
      dubbingSeconds: 10,
      name: 'Marcel',
      autoStart: false,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<TestRoomResponse>();
    expect(body.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(body.token.length).toBeGreaterThan(20);
    const room = rooms.get(body.code)!;
    expect(rooms.isTestRoom(body.code)).toBe(true);
    expect(room.playerCount).toBe(4);
    expect(room.botCount).toBe(3);
    const host = hostOf(room);
    room.connect(host);
    const snap = room.snapshotFor(host)!;
    expect(snap.hostId).toBe(host);
    expect(snap.public).toBeFalsy();
    expect(snap.settings).toMatchObject({ mode: 'extended', rounds: 1, dubbingSeconds: 10 });
    expect(snap.you.canManageBots).toBe(true);
    expect(snap.players.find((p) => p.id === host)!.name).toBe('Marcel');
    // Lobby bot controls work without DEV_BOTS.
    expect(room.handle(host, { t: 'removeBot' })).toBeNull();
    expect(room.handle(host, { t: 'addBot' })).toBeNull();

    // Bots get ready by themselves; the game starts and nothing reaches analytics.
    expect(room.handle(host, { t: 'micStatus', ok: true })).toBeNull();
    expect(room.handle(host, { t: 'setReady', ready: true })).toBeNull();
    await vi.waitFor(() => expect(room.handle(host, { t: 'startGame' })).toBeNull(), {
      timeout: 8000,
      interval: 100,
    });
    expect(room.currentPhase).toBe('DUBBING');
    expect(events).toEqual([]);

    // A normal room still counts (sanity check of the spy).
    rooms.create('Normal');
    expect(events).toContain('room_created');
  });

  describe('autoStart (#53)', () => {
    const made = (autoStart?: boolean) => {
      const r = rooms.createTestRoom({ name: 'Admin', bots: 2, settings: {}, autoStart });
      if (!('room' in r)) throw new Error(r.message);
      return { room: r.room, host: r.join.playerId };
    };

    it('is on by default in the API', async () => {
      const res = await create({ bots: 2 });
      const room = rooms.get(res.json<TestRoomResponse>().code)!;
      const host = hostOf(room);
      room.connect(host);
      expect(room.handle(host, { t: 'micStatus', ok: true })).toBeNull();
      expect(room.currentPhase).toBe('DUBBING');
    });

    it('starts as soon as the connected host reports micOk (no ready/start)', () => {
      const { room, host } = made(true);
      room.connect(host);
      expect(room.currentPhase).toBe('LOBBY');
      room.handle(host, { t: 'micStatus', ok: true });
      expect(room.currentPhase).toBe('DUBBING');
    });

    it('starts at once when the host already passed the mic check before connecting', () => {
      const { room, host } = made(true);
      room.handle(host, { t: 'micStatus', ok: true });
      expect(room.currentPhase).toBe('LOBBY'); // not connected yet
      room.connect(host);
      expect(room.currentPhase).toBe('DUBBING');
    });

    it('skips the mic check when the host has no mic', () => {
      const { room, host } = made(true);
      room.connect(host);
      room.handle(host, { t: 'micStatus', ok: false }); // denied / no device
      expect(room.currentPhase).toBe('DUBBING');
    });

    it('goes without a mic 3 s after the host connected', async () => {
      const { room, host } = made(true);
      room.connect(host);
      expect(room.currentPhase).toBe('LOBBY');
      await vi.waitFor(() => expect(room.currentPhase).toBe('DUBBING'), {
        timeout: AUTO_START_MIC_WAIT_MS + 2000,
        interval: 50,
      });
    });

    it('is one-shot and off when not asked for', () => {
      const off = made(false);
      off.room.connect(off.host);
      off.room.handle(off.host, { t: 'micStatus', ok: true });
      expect(off.room.currentPhase).toBe('LOBBY');
      expect(off.room.handle(off.host, { t: 'micStatus', ok: false })).toBeNull();
      expect(off.room.currentPhase).toBe('LOBBY');
    });

    it('never applies to normal rooms', () => {
      const r = rooms.create('Host');
      if (!('room' in r)) throw new Error('no room');
      const guest = r.room.join('Guest');
      if ('code' in guest) throw new Error('no guest');
      for (const id of [r.join.playerId, guest.playerId]) {
        r.room.connect(id);
        r.room.handle(id, { t: 'micStatus', ok: true });
      }
      expect(r.room.currentPhase).toBe('LOBBY');
      expect(r.room.handle(guest.playerId, { t: 'micStatus', ok: false })).toBeNull();
      expect(r.room.currentPhase).toBe('LOBBY');
    });
  });

  it('normal private rooms still need DEV_BOTS for bots', () => {
    const made = rooms.create('Host');
    if (!('room' in made)) throw new Error('no room');
    const snap = made.room.snapshotFor(made.join.playerId)!;
    expect(snap.you.canManageBots).toBe(false);
    expect(made.room.handle(made.join.playerId, { t: 'addBot' })).toMatchObject({
      code: 'INVALID',
    });
  });
});

describe('test room vs. a cold bot sound pool (#53)', () => {
  it('answers at once, plays pushed pools as they come, keeps old snippet URLs', async () => {
    const sound = (name: string): BotSound => ({
      name,
      durationMs: 3000,
      mime: 'audio/webm;codecs=opus',
      data: Buffer.from(name),
    });
    let finish!: (s: BotSound[]) => void;
    const generating = new Promise<BotSound[]>((r) => (finish = r));
    const listeners = new Set<(p: readonly BotSound[]) => void>();
    let calls = 0;
    const config = testConfig({ adminDev: true, devBots: false });
    const clips = ClipLibrary.load(makeClipsDir(4));
    const rooms = new RoomManager({
      config,
      clips: clips.clips,
      library: clips,
      botSounds: () => {
        calls++;
        return generating;
      },
      onBotSoundsChange: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    });
    const app = await buildApp({ config, clips, rooms });
    try {
      expect(calls).toBe(1); // started at construction (server startup), not lazily
      const t0 = Date.now();
      const res = await app.inject({
        method: 'POST',
        url: TEST_ROOM_PATH,
        payload: { bots: 2 },
        remoteAddress: '127.0.0.1',
      });
      expect(res.statusCode).toBe(201);
      expect(Date.now() - t0).toBeLessThan(1000);
      expect(res.json<TestRoomResponse>().botSounds).toBe(0);

      const tone = sound('synth-440');
      for (const fn of listeners) fn([tone]); // fallback tones while cutting
      expect(rooms.botSoundCount).toBe(1);
      const toneKey = botSoundKey(tone);
      expect(rooms.botSound(toneKey)).toBe(tone);

      finish([sound('s00-0.webm'), sound('s00-1.webm')]);
      await vi.waitFor(() => expect(rooms.botSoundCount).toBe(2));
      // A botVoice URL sent just before the swap still resolves.
      expect(rooms.botSound(toneKey)).toBe(tone);
    } finally {
      await app.close();
      await rooms.stop();
    }
  });
});

describe.skipIf(!hasFfmpeg())('LibraryBotSounds (ffmpeg)', () => {
  const src = tmpDir('dub-botsrc-');
  const clipFile = path.join(src, 'a.mp4');
  execFileSync('ffmpeg', [
    ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi'],
    ...['-i', 'testsrc=size=160x120:rate=5:duration=6', '-f', 'lavfi'],
    ...['-i', 'sine=frequency=330:duration=6', '-c:v', 'libx264', '-preset', 'ultrafast'],
    ...['-c:a', 'aac', '-shortest', clipFile],
  ]);
  fs.copyFileSync(clipFile, path.join(src, 'b.mp4'));

  function fakeLibrary(ids: string[]): SoundSourceLibrary & { pushed: number } {
    const jobs = new JobQueue();
    const lib = {
      pushed: 0,
      summaries: () => [
        { id: 'official', visibility: 'official' },
        { id: 'mine', visibility: 'private' },
      ],
      clipsOf: (id: string) =>
        id === 'official'
          ? ids.map((c) => ({ id: c, durationMs: 6000 }))
          : [{ id: 'private-clip', durationMs: 6000 }],
      clipMeta: (id: string) => ({ file: id === 'private-clip' ? 'a.mp4' : `${id}.mp4`, dir: src }),
      jobs: {
        push: <T>(job: () => Promise<T>, opts?: { priority?: 'admin' | 'user' | 'low' }) => {
          expect(opts?.priority).toBe('low');
          lib.pushed++;
          return jobs.push(job, opts);
        },
      },
    };
    return lib;
  }

  it('cuts snippets from official clips, caches them, regenerates at most hourly', async () => {
    let now = Date.UTC(2026, 9, 18, 12);
    const libraryDir = tmpDir('dub-libdir-');
    const lib = fakeLibrary(['a']);
    const pool = new LibraryBotSounds({
      library: lib,
      libraryDir,
      clipsDir: makeClipsDir(1),
      now: () => now,
    });
    const pushed: number[] = [];
    pool.onChange((p) => pushed.push(p.length));
    const first = await pool.get();
    expect(first.length).toBeGreaterThan(0);
    // #53: fallback tones / partial snippets first, then the final pool.
    expect(pushed.length).toBeGreaterThanOrEqual(2);
    expect(pushed.at(-1)).toBe(first.length);
    expect(lib.pushed).toBe(1);
    for (const s of first) {
      expect(s.mime).toBe('audio/webm;codecs=opus');
      expect(s.durationMs).toBeGreaterThanOrEqual(SNIPPET.minMs); // #47: 3–8 s
      expect(s.durationMs).toBeLessThanOrEqual(SNIPPET.maxMs);
    }
    const manifest = JSON.parse(
      fs.readFileSync(path.join(libraryDir, '.bot-sounds', 'manifest.json'), 'utf8'),
    );
    expect(manifest.sounds.every((s: { clipId: string }) => s.clipId === 'a')).toBe(true);
    expect(manifest.recipe).toBe(SNIPPET_RECIPE);
    expect(await pool.get()).toBe(first); // cached
    expect(lib.pushed).toBe(1);

    // A new process with the same library reuses the disk cache.
    const again = new LibraryBotSounds({
      library: lib,
      libraryDir,
      clipsDir: makeClipsDir(1),
      now: () => now,
    });
    expect((await again.get()).length).toBe(first.length);
    expect(lib.pushed).toBe(1);

    // The library changes: the old pool keeps playing for up to an hour, then regenerates.
    const changed = fakeLibrary(['a', 'b']);
    const p2 = new LibraryBotSounds({
      library: changed,
      libraryDir,
      clipsDir: makeClipsDir(1),
      now: () => now,
    });
    expect((await p2.get()).length).toBe(first.length);
    expect(changed.pushed).toBe(0);
    now += 3600_000 + 1;
    const regenerated = await p2.get();
    expect(changed.pushed).toBe(1);
    expect(regenerated.length).toBeGreaterThan(0);
  }, 60_000);
});
