import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { PresenceC2S, PresenceS2C, RoomSnapshot } from '@dub/shared';
import { loadConfig } from '../../src/config.js';
import { startServer, type RunningServer } from '../../src/bootstrap.js';
import { tmpDir } from '../helpers.js';
import { FakeClient, makeFixtureClips } from './fakeClient.js';

/** `/ws/presence` client for the queue (V08). */
class QueueSocket {
  readonly ws: WebSocket;
  readonly got: PresenceS2C[] = [];
  readonly opened: Promise<void>;
  private waiters: { pred: (m: PresenceS2C) => boolean; resolve: (m: PresenceS2C) => void }[] = [];

  constructor(base: string, cookie?: string) {
    this.ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws/presence', {
      headers: cookie ? { cookie } : {},
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

  wait<T extends PresenceS2C['t']>(
    t: T,
    pred: (m: Extract<PresenceS2C, { t: T }>) => boolean = () => true,
    timeoutMs = 5000,
    since = 0,
  ): Promise<Extract<PresenceS2C, { t: T }>> {
    const p = (m: PresenceS2C) => m.t === t && pred(m as Extract<PresenceS2C, { t: T }>);
    const hit = this.got.slice(since).find(p);
    if (hit) return Promise.resolve(hit as Extract<PresenceS2C, { t: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`timeout waiting for ${t}; got ${JSON.stringify(this.got.slice(-3))}`)),
        timeoutMs,
      );
      this.waiters.push({
        pred: p,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m as Extract<PresenceS2C, { t: T }>);
        },
      });
    });
  }

  close(): void {
    this.ws.close();
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
    CLIPS_DIR: makeFixtureClips(3, 500),
    DATA_DIR: tmpDir('dub-pub-data-'),
    CLIENT_DIST: tmpDir('dub-pub-noclient-'),
    DB_PATH: ':memory:',
  });
  srv = await startServer(config);
}, 30_000);

afterAll(async () => {
  for (const s of sockets) s.close();
  // Kicked / requeued / rejected sockets are already closed by the server.
  for (const c of clients) if (c.ws?.readyState === WebSocket.OPEN) await c.drop();
  await srv?.close();
});

async function guestCookie(): Promise<string> {
  const r = await srv.app.inject('/api/me');
  const set = r.headers['set-cookie'];
  return (Array.isArray(set) ? set[0]! : set!).split(';')[0]!;
}

/** Queues `names` (each with its own guest cookie) and returns them matched into one room. */
async function matchOf(names: string[]) {
  const qs: QueueSocket[] = [];
  for (const name of names) {
    const q = new QueueSocket(srv.url, await guestCookie());
    sockets.push(q);
    await q.opened;
    q.send({ t: 'queueJoin', name });
    await q.wait('queue');
    qs.push(q);
  }
  const found = await Promise.all(qs.map((q) => q.wait('matchFound')));
  const code = found[0]!.code;
  expect(found.every((f) => f.code === code)).toBe(true);
  const players = names.map((n, i) => new FakeClient(srv.url, code, n, found[i]!.token));
  clients.push(...players);
  for (const p of players) await p.connect();
  return { code, qs, players };
}

const ready = (c: FakeClient) => {
  c.send({ t: 'micStatus', ok: true });
  c.send({ t: 'setReady', ready: true });
};

describe('public matchmaking (V08)', () => {
  it('3 queue, get matched, play a server-hosted game to FINAL', { timeout: 30_000 }, async () => {
    const watcher = new QueueSocket(srv.url);
    sockets.push(watcher);
    const { code, qs, players } = await matchOf(['Ann', 'Bob', 'Cid']);
    expect(srv.matchmaker.size).toBe(0);
    await watcher.wait('counts', (c) => c.lookingForGame === 0);

    const lobby = await players[0]!.state((s) => s.players.length === 3);
    expect(lobby.kind).toBe('public');
    expect(lobby.hostId).toBe('');
    expect(lobby.settings.mode).toBe('normal');
    expect(lobby.public?.readyEndsAt).toBeGreaterThan(Date.now() - 1000);
    expect(lobby.you.canManageBots).toBe(false);

    // Joining without a token is rejected; so is anything host-only.
    const eve = new FakeClient(srv.url, code, 'Eve');
    clients.push(eve);
    await expect(eve.connect()).rejects.toThrow(/GAME_IN_PROGRESS/);
    const info = await fetch(`${srv.url}/api/rooms/${code}`).then((r) => r.json());
    expect(info).toMatchObject({ joinable: false });
    players[0]!.send({ t: 'addBot' });
    players[0]!.send({ t: 'startGame' });
    await players[0]!.wait((m) => m.t === 'error' && m.code === 'NOT_HOST');

    // Everyone ready before the deadline: starts at once.
    for (const p of players) ready(p);
    for (let round = 0; round < 3; round++) {
      await Promise.all(
        players.map((p) => p.state((s) => s.phase === 'DUBBING' && s.round === round)),
      );
      for (const p of players) p.send({ t: 'dubDone', round, done: true });
    }
    const fin = await players[0]!.state((s) => s.phase === 'FINAL', 15_000);
    expect(fin.final?.standings).toHaveLength(3);
    players[0]!.send({ t: 'backToLobby' });
    await players[0]!.wait((m) => m.t === 'error' && m.code === 'NOT_HOST');

    // "Play again" = queue again from the same presence socket.
    qs[0]!.send({ t: 'queueJoin', name: 'Ann' });
    await qs[0]!.wait('queue', (m) => m.position === 1, 5000, qs[0]!.got.length);
    qs[0]!.send({ t: 'queueLeave' });
    await qs[0]!.wait('queueLeft');
    expect(srv.matchmaker.size).toBe(0);
  });

  it(
    'a player who misses the ready check goes back to the front of the queue',
    { timeout: 20_000 },
    async () => {
      const { qs, players } = await matchOf(['Dee', 'Eli', 'Fay']);
      const [dee, eli, fay] = players as [FakeClient, FakeClient, FakeClient];
      const waitedBefore = qs[2]!.got.filter((m) => m.t === 'queue').at(-1)!;
      ready(dee);
      ready(eli);
      fay.send({ t: 'micStatus', ok: true }); // never presses ready
      await fay.wait((m) => m.t === 'requeued', 6000);
      const q = await qs[2]!.wait('queue', (m) => m.position === 1, 3000, 0);
      expect(q.waitedMs).toBeGreaterThan(waitedBefore.t === 'queue' ? waitedBefore.waitedMs : 0);
      const s = await dee.state((x) => x.phase === 'DUBBING');
      expect(s.players.map((p) => p.name).sort()).toEqual(['Dee', 'Eli']);
      qs[2]!.send({ t: 'queueLeave' });
      await qs[2]!.wait('queueLeft');
    },
  );

  it(
    'report is stored; a majority vote-kicks; the kicked player is blocked from queueing',
    { timeout: 20_000 },
    async () => {
      const { code, qs, players } = await matchOf(['Gil', 'Hal', 'Ivy']);
      const [gil, hal, ivy] = players as [FakeClient, FakeClient, FakeClient];
      for (const p of players) ready(p);
      await gil.state((s) => s.phase === 'DUBBING');

      gil.send({ t: 'report', playerId: ivy.playerId, reason: 'slurs on voice' });
      await gil.state((s) => (s.public?.youReported ?? []).includes(ivy.playerId));
      gil.send({ t: 'report', playerId: ivy.playerId, reason: 'again' });
      await gil.wait((m) => m.t === 'error' && m.code === 'LIMIT');
      const rows = srv.reports.list();
      expect(rows[0]).toMatchObject({
        roomCode: code,
        reporterName: 'Gil',
        reportedName: 'Ivy',
        reason: 'slurs on voice',
      });
      expect(rows[0]!.reportedUserId).toBeTruthy();

      gil.send({ t: 'voteKick', playerId: ivy.playerId, kick: true });
      const mid: RoomSnapshot = await hal.state((s) => s.public?.kickVotes[ivy.playerId] === 1);
      expect(mid.public?.kickNeeded).toBe(2);
      hal.send({ t: 'voteKick', playerId: ivy.playerId, kick: true });
      await ivy.wait((m) => m.t === 'kicked' && m.by === 'vote');
      const after = await gil.state((s) => s.players.length === 2);
      expect(after.phase).toBe('DUBBING'); // game goes on

      qs[2]!.send({ t: 'queueJoin', name: 'Ivy' });
      const e = await qs[2]!.wait('error');
      expect(e.code).toBe('BLOCKED');
      expect(srv.matchmaker.size).toBe(0);
    },
  );
});
