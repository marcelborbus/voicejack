import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Phase, PlayerId, S2C, ShowcaseStatus } from '@dub/shared';
import type { FastifyInstance } from 'fastify';
import type { BotSound } from '../src/bots/BotPlayer.js';
import {
  BOT_VOICE,
  BotVoiceScheduler,
  botMayTalk,
  botSoundKey,
  botSoundUrl,
} from '../src/bots/BotVoice.js';
import { buildApp } from '../src/http/app.js';
import { ClipLibrary } from '../src/clips/ClipLibrary.js';
import { RoomManager, type Connection } from '../src/room/RoomManager.js';
import { realScheduler } from '../src/room/timers.js';
import { makeClipsDir, testConfig } from './helpers.js';

const SOUNDS: BotSound[] = [3000, 5000, 8000].map((ms, i) => ({
  name: `v${i}`,
  durationMs: ms,
  mime: 'audio/webm;codecs=opus',
  data: Buffer.alloc(300 + i, i + 1),
}));

function seeded(seed = 9) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('BotVoiceScheduler (v1.2 #47)', () => {
  function harness(botIds: PlayerId[]) {
    const state = {
      phase: 'LOBBY' as Phase,
      showcaseStatus: null as ShowcaseStatus | null,
      bots: botIds.map((id) => ({ id, mutedByHost: false })),
      gone: false,
    };
    const said: { id: PlayerId; at: number; ms: number; phase: Phase; status: string | null }[] =
      [];
    const v = new BotVoiceScheduler({
      clock: { now: () => Date.now() },
      scheduler: realScheduler,
      rng: seeded(),
      state: () => (state.gone ? null : state),
      sounds: () => SOUNDS,
      speak: (id, s) =>
        said.push({
          id,
          at: Date.now(),
          ms: s.durationMs,
          phase: state.phase,
          status: state.showcaseStatus,
        }),
    });
    v.sync();
    return { v, state, said };
  }

  it('talks only while voice is allowed, never in DUBBING or over a PLAYING dub', async () => {
    expect(botMayTalk('LOBBY', null)).toBe(true);
    expect(botMayTalk('DUBBING', null)).toBe(false);
    expect(botMayTalk('SHOWCASE', 'PLAYING')).toBe(false);
    expect(botMayTalk('SHOWCASE', 'LOADING')).toBe(true);
    expect(botMayTalk('SHOWCASE', 'LOCKED')).toBe(true);
    expect(botMayTalk('ROUND_RESULTS', null)).toBe(true);
    expect(botMayTalk('FINAL', null)).toBe(true);

    const h = harness(['b1', 'b2', 'b3']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.said.length).toBeGreaterThan(3);
    const n = h.said.length;
    h.state.phase = 'DUBBING';
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.said.length).toBe(n);
    h.state.phase = 'SHOWCASE';
    h.state.showcaseStatus = 'PLAYING';
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.said.length).toBe(n);
    // Between dubs it picks up again within a retry interval.
    h.state.showcaseStatus = 'LOCKED';
    await vi.advanceTimersByTimeAsync(BOT_VOICE.retryMs[1] + 10);
    expect(h.said.length).toBeGreaterThan(n);
    for (const s of h.said) {
      expect(s.phase).not.toBe('DUBBING');
      expect(s.status).not.toBe('PLAYING');
    }
  });

  it('staggers: one bot at a time, each with a 6–20 s gap after its own line', async () => {
    const h = harness(['b1', 'b2', 'b3', 'b4']);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.said.length).toBeGreaterThan(20);
    for (let i = 1; i < h.said.length; i++) {
      const prev = h.said[i - 1]!;
      expect(h.said[i]!.at).toBeGreaterThanOrEqual(prev.at + prev.ms); // never overlapping
    }
    for (const id of ['b1', 'b2', 'b3', 'b4']) {
      const mine = h.said.filter((s) => s.id === id);
      expect(mine.length).toBeGreaterThan(3);
      for (let i = 1; i < mine.length; i++) {
        const gap = mine[i]!.at - (mine[i - 1]!.at + mine[i - 1]!.ms);
        expect(gap).toBeGreaterThanOrEqual(BOT_VOICE.gapMs[0]);
      }
    }
    // Not all at once at the start either.
    expect(new Set(h.said.slice(0, 4).map((s) => s.at)).size).toBe(4);
  });

  it('skips host-muted bots and stops when the room is disposed', async () => {
    const h = harness(['b1', 'b2']);
    h.state.bots[0]!.mutedByHost = true;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.said.length).toBeGreaterThan(0);
    expect(h.said.every((s) => s.id === 'b2')).toBe(true);
    h.state.gone = true; // room gone: the next turn disposes the scheduler
    const n = h.said.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.said.length).toBe(n);
    expect(vi.getTimerCount()).toBe(0);
    // Explicit dispose clears every timer too.
    const g = harness(['x']);
    expect(vi.getTimerCount()).toBe(1);
    g.v.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('content-addressed sound urls', () => {
    expect(botSoundKey(SOUNDS[0]!)).toMatch(/^[0-9a-f]{24}\.webm$/);
    expect(botSoundKey(SOUNDS[0]!)).not.toBe(botSoundKey(SOUNDS[1]!));
    expect(botSoundUrl(SOUNDS[0]!)).toBe(`/api/bot-sounds/${botSoundKey(SOUNDS[0]!)}`);
  });
});

describe('bot voice in a room (v1.2 #47)', () => {
  let rooms: RoomManager;
  let app: FastifyInstance | null = null;
  beforeEach(() => {
    rooms = new RoomManager({
      config: testConfig({ devBots: true }),
      clips: ClipLibrary.load(makeClipsDir(4)).clips,
      bots: { sounds: SOUNDS, put: async () => {} },
      rng: seeded(4),
    });
  });
  afterEach(async () => {
    await app?.close();
    app = null;
    await rooms.stop();
  });

  it('broadcasts botVoice to humans only, serves the snippet, stops on dispose', async () => {
    const made = rooms.create('Ann');
    if (!('room' in made)) throw new Error('no room');
    const { room, join } = made;
    const got: S2C[] = [];
    const conn: Connection = { send: (m) => void got.push(m), close: () => {} };
    room.connect(join.playerId);
    rooms.attach(room.code, join.playerId, conn);
    expect(room.handle(join.playerId, { t: 'addBot' })).toBeNull();
    expect(room.handle(join.playerId, { t: 'addBot' })).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    const voices = got.filter((m): m is Extract<S2C, { t: 'botVoice' }> => m.t === 'botVoice');
    expect(voices.length).toBeGreaterThan(1);
    const botIds = room.playerIds().filter((p) => p !== join.playerId);
    for (const v of voices) {
      expect(botIds).toContain(v.playerId);
      expect(v.soundUrl).toMatch(/^\/api\/bot-sounds\/[0-9a-f]{24}\.webm$/);
      expect(SOUNDS.map((s) => s.durationMs)).toContain(v.durationMs);
    }

    // The host mutes one bot for everyone: it falls silent.
    expect(
      room.handle(join.playerId, { t: 'hostMute', playerId: botIds[0]!, muted: true }),
    ).toBeNull();
    got.length = 0;
    await vi.advanceTimersByTimeAsync(120_000);
    const after = got.filter((m) => m.t === 'botVoice') as Extract<S2C, { t: 'botVoice' }>[];
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((m) => m.playerId === botIds[1])).toBe(true);

    await rooms.dispose(room.code);
    got.length = 0;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(got.filter((m) => m.t === 'botVoice')).toEqual([]);

    // The snippet behind the url (open path, only pool contents, content-addressed).
    vi.useRealTimers();
    const clips = ClipLibrary.load(makeClipsDir(1));
    app = await buildApp({ config: testConfig(), clips, rooms });
    const res = await app.inject({ method: 'GET', url: voices[0]!.soundUrl });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('audio/webm');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(SOUNDS.some((s) => s.data.equals(res.rawPayload))).toBe(true);
    for (const url of [
      '/api/bot-sounds/' + '0'.repeat(24) + '.webm',
      '/api/bot-sounds/..%2F.env',
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
  });
});
