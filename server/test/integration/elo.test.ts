import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  LAST_GAME_PATH,
  type LastGameResponse,
  type PresenceC2S,
  type PresenceS2C,
} from '@dub/shared';
import { loadConfig } from '../../src/config.js';
import { startServer, type RunningServer } from '../../src/bootstrap.js';
import { tmpDir } from '../helpers.js';
import { FakeClient, chunkMeta, makeFixtureClips } from './fakeClient.js';

/** Minimal `/ws/presence` client for the queue. */
class QueueSocket {
  readonly ws: WebSocket;
  readonly got: PresenceS2C[] = [];
  readonly opened: Promise<void>;
  private waiters: { pred: (m: PresenceS2C) => boolean; resolve: (m: PresenceS2C) => void }[] = [];

  constructor(base: string, cookie: string) {
    this.ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws/presence', {
      headers: { cookie },
    });
    this.opened = new Promise((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as PresenceS2C;
      this.got.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
  }

  send(m: PresenceC2S): void {
    this.ws.send(JSON.stringify(m));
  }

  wait<T extends PresenceS2C['t']>(t: T, since = 0): Promise<Extract<PresenceS2C, { t: T }>> {
    type M = Extract<PresenceS2C, { t: T }>;
    const hit = this.got.slice(since).find((m) => m.t === t);
    if (hit) return Promise.resolve(hit as M);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), 5000);
      this.waiters.push({
        pred: (m) => m.t === t,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as M);
        },
      });
    });
  }
}

let srv: RunningServer;
const sockets: QueueSocket[] = [];
const clients: FakeClient[] = [];

beforeAll(async () => {
  const config = loadConfig({
    TIMINGS: 'fast',
    PORT: '0',
    HOST: '127.0.0.1',
    CLIPS_DIR: makeFixtureClips(4, 500),
    DATA_DIR: tmpDir('dub-elo-data-'),
    CLIENT_DIST: tmpDir('dub-elo-noclient-'),
    DB_PATH: ':memory:',
  });
  srv = await startServer(config);
}, 30_000);

afterAll(async () => {
  for (const s of sockets) s.ws.close();
  for (const c of clients) if (c.ws?.readyState === WebSocket.OPEN) await c.drop();
  await srv?.close();
});

async function guest(): Promise<{ cookie: string; id: string }> {
  const r = await srv.app.inject('/api/me');
  const set = r.headers['set-cookie'];
  const cookie = (Array.isArray(set) ? set[0]! : set!).split(';')[0]!;
  return { cookie, id: (r.json() as { user: { id: string } }).user.id };
}

const ready = (c: FakeClient) => {
  c.send({ t: 'micStatus', ok: true });
  c.send({ t: 'setReady', ready: true });
};

/** Plays `rounds` rounds: only `dubber` records, everyone else votes 8 on each item. */
async function playToFinal(all: FakeClient[], dubber: FakeClient, rounds: number) {
  for (let round = 0; round < rounds; round++) {
    await Promise.all(all.map((p) => p.state((s) => s.phase === 'DUBBING' && s.round === round)));
    const k = chunkMeta(`d-${round}`, 0, 64);
    expect((await dubber.upload(round, k.id, Buffer.alloc(k.bytes, 1))).status).toBe(201);
    dubber.send({ t: 'manifest', round, chunks: [k] });
    await dubber.state((s) => s.you.manifest.length === 1);
    for (const p of all) p.send({ t: 'dubDone', round, done: true });
    const seen = new Set<string>();
    for (;;) {
      const s = await all[0]!.state(
        (x) =>
          (x.phase === 'ROUND_RESULTS' && x.round === round) ||
          (x.phase === 'SHOWCASE' &&
            x.showcase!.status === 'LOADING' &&
            !seen.has(x.showcase!.submissionId)),
        8000,
      );
      if (s.phase !== 'SHOWCASE') break;
      const item = s.showcase!;
      seen.add(item.submissionId);
      for (const p of all) p.send({ t: 'preloaded', submissionId: item.submissionId });
      const playing = await Promise.all(
        all.map((p) =>
          p.state(
            (x) =>
              x.showcase?.submissionId === item.submissionId && x.showcase.status === 'PLAYING',
          ),
        ),
      );
      all.forEach((p, i) => {
        if (!playing[i]!.you.isOwnItem)
          p.send({ t: 'vote', submissionId: item.submissionId, score: 8 });
      });
    }
  }
  return Promise.all(all.map((p) => p.state((s) => s.phase === 'FINAL', 10_000)));
}

const userRow = (id: string) =>
  srv.db.prepare('SELECT elo, public_games_played FROM users WHERE id = ?').get(id) as {
    elo: number;
    public_games_played: number;
  };
const gameCount = () =>
  Number((srv.db.prepare('SELECT COUNT(*) AS n FROM games').get() as { n: number }).n);

describe('Elo (V09)', () => {
  it(
    'a public game updates Elo and writes the history; ranked unlocks after 3 games',
    { timeout: 40_000 },
    async () => {
      const users = [await guest(), await guest(), await guest()];
      const names = ['Ann', 'Bob', 'Cid'];
      const qs = users.map((u) => new QueueSocket(srv.url, u.cookie));
      sockets.push(...qs);
      for (const q of qs) await q.opened;

      // Ranked is locked below 3 public games.
      qs[0]!.send({ t: 'queueJoin', name: 'Ann', mode: 'ranked' });
      expect((await qs[0]!.wait('error')).message).toMatch(/Ranked unlocks after 3/);

      qs.forEach((q, i) => q.send({ t: 'queueJoin', name: names[i]!, mode: 'casual' }));
      const found = await Promise.all(qs.map((q) => q.wait('matchFound')));
      const code = found[0]!.code;
      const players = names.map((n, i) => {
        const c = new FakeClient(srv.url, code, n, found[i]!.token);
        c.cookie = users[i]!.cookie;
        return c;
      });
      clients.push(...players);
      for (const p of players) await p.connect();
      await players[0]!.state((s) => s.players.length === 3);
      for (const p of players) ready(p);
      const fin = await playToFinal(players, players[0]!, 3);
      expect(fin[0]!.final!.standings[0]!.playerId).toBe(players[0]!.playerId);

      // Ann won; Bob and Cid tied (0 points) for second: a draw between them.
      expect(userRow(users[0]!.id)).toEqual({ elo: 1016, public_games_played: 1 });
      expect(userRow(users[1]!.id)).toEqual({ elo: 992, public_games_played: 1 });
      expect(userRow(users[2]!.id)).toEqual({ elo: 992, public_games_played: 1 });
      const rows = srv.db
        .prepare(
          `SELECT g.kind, g.room_code, gp.user_id, gp.place, gp.elo_before, gp.elo_after
         FROM game_players gp JOIN games g ON g.id = gp.game_id ORDER BY gp.place, gp.user_id`,
        )
        .all();
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({
        kind: 'casual',
        room_code: code,
        user_id: users[0]!.id,
        place: 1,
        elo_before: 1000,
        elo_after: 1016,
      });

      const res = await srv.app.inject({
        url: `${LAST_GAME_PATH}?room=${code}`,
        headers: { cookie: users[1]!.cookie },
      });
      expect((res.json() as LastGameResponse).game).toMatchObject({
        kind: 'casual',
        place: 2,
        players: 3,
        eloBefore: 1000,
        eloAfter: 992,
      });

      // After 3 public games ranked is accepted.
      srv.db.prepare('UPDATE users SET public_games_played = 3 WHERE id = ?').run(users[0]!.id);
      const since = qs[0]!.got.length;
      qs[0]!.send({ t: 'queueJoin', name: 'Ann', mode: 'ranked' });
      expect((await qs[0]!.wait('queue', since)).position).toBe(1);
      expect(srv.matchmaker.matcher.entries()[0]).toMatchObject({ mode: 'ranked', elo: 1016 });
      qs[0]!.send({ t: 'queueLeave' });
      await qs[0]!.wait('queueLeft', since);
    },
  );

  it('a private game never touches Elo', { timeout: 30_000 }, async () => {
    const users = [await guest(), await guest(), await guest()];
    const before = gameCount();
    const res = await fetch(srv.url + '/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: users[0]!.cookie },
      body: JSON.stringify({ name: 'Pia' }),
    });
    const created = (await res.json()) as { code: string; token: string };
    const pia = new FakeClient(srv.url, created.code, 'Pia', created.token);
    const quin = new FakeClient(srv.url, created.code, 'Quin');
    const rae = new FakeClient(srv.url, created.code, 'Rae');
    const all = [pia, quin, rae];
    all.forEach((c, i) => (c.cookie = users[i]!.cookie));
    clients.push(...all);
    for (const c of all) await c.connect();
    pia.send({ t: 'updateSettings', settings: { mode: 'extended', rounds: 1, dubbingSeconds: 5 } });
    await pia.state((s) => s.settings.rounds === 1 && s.players.length === 3);
    for (const c of all) ready(c);
    await pia.state((s) => s.you.canStart);
    pia.send({ t: 'startGame' });
    const fin = await playToFinal(all, pia, 1);
    expect(fin[0]!.final!.standings[0]!.playerId).toBe(pia.playerId);
    expect(gameCount()).toBe(before);
    for (const u of users) expect(userRow(u.id)).toEqual({ elo: 1000, public_games_played: 0 });
  });
});
