import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoomSnapshot } from '@dub/shared';
import { loadConfig } from '../../src/config.js';
import { startServer, type RunningServer } from '../../src/bootstrap.js';
import { tmpDir } from '../helpers.js';
import { FakeClient, makeFixtureClips } from './fakeClient.js';

let srv: RunningServer;
let ann: FakeClient | undefined;

beforeAll(async () => {
  const config = loadConfig({
    TIMINGS: 'fast',
    DEV_BOTS: '1',
    PORT: '0',
    HOST: '127.0.0.1',
    CLIPS_DIR: makeFixtureClips(2, 1000),
    DATA_DIR: tmpDir('dub-bots-data-'),
    CLIENT_DIST: tmpDir('dub-bots-noclient-'),
    DB_PATH: ':memory:',
  });
  srv = await startServer(config);
  await srv.rooms.botsReady;
}, 30_000);

afterAll(async () => {
  await ann?.drop();
  await srv?.close();
});

const ROUNDS = 1;

describe('bots over WS (DEV_BOTS=1)', () => {
  it('1 human + 3 bots play to FINAL', { timeout: 30_000 }, async () => {
    const res = await fetch(srv.url + '/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ann' }),
    });
    const created = (await res.json()) as { code: string; token: string };
    ann = new FakeClient(srv.url, created.code, 'Ann', created.token);
    await ann.connect();
    expect((await ann.state(() => true)).you.canManageBots).toBe(true);

    for (let i = 0; i < 3; i++) ann.send({ t: 'addBot' });
    ann.send({
      t: 'updateSettings',
      settings: { mode: 'extended', rounds: ROUNDS, dubbingSeconds: 5 },
    });
    ann.send({ t: 'micStatus', ok: true });
    ann.send({ t: 'setReady', ready: true });
    const lobby = await ann.state((s) => s.players.length === 4 && s.you.canStart);
    expect(lobby.players.filter((p) => p.isBot)).toHaveLength(3);
    expect(lobby.players.filter((p) => p.isBot).every((p) => p.micOk && p.ready)).toBe(true);
    ann.send({ t: 'startGame' });

    const withSounds = srv.rooms.botSoundCount > 0;
    for (let round = 0; round < ROUNDS; round++) {
      await ann.state((s) => s.phase === 'DUBBING' && s.round === round);
      // Bots finish well inside the 5 s; the human submits an empty dub.
      await ann.state(
        (s) => s.players.filter((p) => p.isBot).every((p) => p.dubDone),
        5000,
      );
      ann.send({ t: 'dubDone', round, done: true });

      const preloaded = new Set<string>();
      let downloaded = false;
      let s: RoomSnapshot;
      for (;;) {
        s = await ann.state(
          (x) =>
            x.phase === 'ROUND_RESULTS' ||
            (x.phase === 'SHOWCASE' &&
              x.showcase!.status === 'LOADING' &&
              !preloaded.has(x.showcase!.submissionId)),
          8000,
        );
        if (s.phase === 'ROUND_RESULTS') break;
        const item = s.showcase!;
        preloaded.add(item.submissionId);
        if (!downloaded) {
          const r = await ann.download(item.chunks[0]!.url);
          expect(r.status).toBe(200);
          expect((await r.arrayBuffer()).byteLength).toBe(item.chunks[0]!.bytes);
          downloaded = true;
        }
        expect(item.chunks.length).toBeGreaterThanOrEqual(2);
        ann.send({ t: 'preloaded', submissionId: item.submissionId });
      }
      const entries = s.roundResult!.entries;
      expect(entries).toHaveLength(4);
      for (const e of entries) {
        const bot = s.players.find((p) => p.id === e.playerId)!.isBot;
        expect(e.empty).toBe(!bot || !withSounds);
        if (bot && withSounds) expect(e.votes).toBe(2); // the other two bots
      }
      ann.send({ t: 'advance' });
    }
    const fin = await ann.state((s) => s.phase === 'FINAL');
    expect(fin.final!.standings).toHaveLength(4);
    expect(ann.errors()).toEqual([]);
  });
});
