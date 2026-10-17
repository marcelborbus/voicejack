import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRESENCE_THROTTLE_MS,
  PROTOCOL_VERSION,
  type ClipInfo,
  type PresenceS2C,
  type S2C,
} from '@dub/shared';
import { startServer, type RunningServer } from '../src/bootstrap.js';
import { Presence, type PresenceClient } from '../src/presence/Presence.js';
import { RoomManager, type Connection } from '../src/room/RoomManager.js';
import { makeClipsDir, testConfig } from './helpers.js';
import { TestSocket } from './wsClient.js';

function clip(id: string): ClipInfo {
  return {
    id,
    title: id,
    url: `/clips/${id}.mp4`,
    durationMs: 8000,
    width: 640,
    height: 360,
    tags: [],
    attribution: { author: 'a', source: 's', license: 'CC0' },
  };
}

class FakeClient implements PresenceClient {
  readonly got: PresenceS2C[] = [];
  closed = false;
  send(m: PresenceS2C) {
    this.got.push(m);
  }
  close() {
    this.closed = true;
  }
  get counts() {
    return this.got.filter((m) => m.t === 'counts');
  }
  get last() {
    return this.counts.at(-1);
  }
}

const conn = (): Connection => ({ send: () => {}, close: () => {} });

describe('Presence (unit)', () => {
  let rooms: RoomManager;
  let presence: Presence;

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    rooms = new RoomManager({
      config: testConfig({ allowSolo: true, devBots: true }),
      clips: [clip('a'), clip('b'), clip('c')],
    });
    presence = new Presence({ rooms });
  });
  afterEach(() => {
    presence.dispose();
    vi.useRealTimers();
  });

  it('sends counts on connect, then pushes changes', () => {
    const a = new FakeClient();
    presence.add(a, null);
    expect(a.last).toEqual({ t: 'counts', online: 1, inGame: 0, lookingForGame: 0 });
    const b = new FakeClient();
    const removeB = presence.add(b, null);
    vi.advanceTimersByTime(PRESENCE_THROTTLE_MS);
    expect(a.last).toMatchObject({ online: 2 });
    removeB();
    vi.advanceTimersByTime(PRESENCE_THROTTLE_MS);
    expect(a.last).toMatchObject({ online: 1 });
  });

  it('counts a cookie user once across tabs, anonymous sockets each', () => {
    const tabs = [new FakeClient(), new FakeClient(), new FakeClient(), new FakeClient()];
    presence.add(tabs[0]!, 'u1');
    presence.add(tabs[1]!, 'u1');
    presence.add(tabs[2]!, null);
    presence.add(tabs[3]!, null);
    expect(presence.counts().online).toBe(3);
    expect(presence.isOnline('u1')).toBe(true);
    expect(presence.sendToUser('u1', { t: 'pong', c: 0, s: 0 })).toBe(2);
  });

  it('throttles pushes to at most one per interval and skips unchanged counts', () => {
    const watcher = new FakeClient();
    presence.add(watcher, null);
    vi.advanceTimersByTime(0); // first broadcast (online 1)
    const before = watcher.counts.length;
    const removers: (() => void)[] = [];
    for (let i = 0; i < 10; i++) {
      removers.push(presence.add(new FakeClient(), null));
      vi.advanceTimersByTime(50);
    }
    // 500 ms passed: still inside the window of the first broadcast → no push yet.
    expect(watcher.counts.length).toBe(before);
    vi.advanceTimersByTime(PRESENCE_THROTTLE_MS);
    expect(watcher.counts.length).toBe(before + 1);
    expect(watcher.last).toMatchObject({ online: 11 });
    // Net no-op changes do not push.
    const extra = presence.add(new FakeClient(), null);
    extra();
    vi.advanceTimersByTime(PRESENCE_THROTTLE_MS * 3);
    expect(watcher.counts.length).toBe(before + 1);
    for (const r of removers) r();
  });

  it('follows room join/leave and phase changes; bots never count', () => {
    const watcher = new FakeClient();
    presence.add(watcher, null);
    const made = rooms.create('Host');
    if (!('room' in made)) throw new Error('create failed');
    const { room, join } = made;
    const hostConn = conn();
    rooms.attach(room.code, join.playerId, hostConn);
    room.linkUser(join.playerId, 'host-user');
    room.connect(join.playerId);
    vi.advanceTimersByTime(PRESENCE_THROTTLE_MS);
    expect(watcher.last).toEqual({ t: 'counts', online: 2, inGame: 0, lookingForGame: 0 });

    // Same cookie user also on the home page: still one identity.
    presence.add(new FakeClient(), 'host-user');
    expect(presence.counts().online).toBe(2);

    expect(room.handle(join.playerId, { t: 'addBot' })).toBeNull();
    expect(room.handle(join.playerId, { t: 'addBot' })).toBeNull();
    expect(room.botCount).toBe(2);
    expect(presence.counts()).toMatchObject({ online: 2, inGame: 0 });

    expect(room.handle(join.playerId, { t: 'micStatus', ok: true })).toBeNull();
    expect(room.handle(join.playerId, { t: 'setReady', ready: true })).toBeNull();
    vi.advanceTimersByTime(3000); // bots pass the mic check and get ready
    expect(room.handle(join.playerId, { t: 'startGame' })).toBeNull();
    expect(room.currentPhase).toBe('DUBBING');
    vi.advanceTimersByTime(PRESENCE_THROTTLE_MS);
    expect(watcher.last).toMatchObject({ online: 2, inGame: 1 });

    // Host socket drops: no longer online via the room, nor in game.
    rooms.detach(room.code, join.playerId, hostConn);
    room.disconnect(join.playerId);
    vi.advanceTimersByTime(PRESENCE_THROTTLE_MS);
    expect(watcher.last).toMatchObject({ online: 2, inGame: 0 }); // host-user still on home
  });

  it('setLooking feeds lookingForGame (V08 hook)', () => {
    const watcher = new FakeClient();
    presence.add(watcher, 'u1');
    presence.setLooking('u1', true);
    presence.setLooking('u1', true);
    vi.advanceTimersByTime(PRESENCE_THROTTLE_MS);
    expect(watcher.last).toMatchObject({ lookingForGame: 1 });
    presence.setLooking('u1', false);
    vi.advanceTimersByTime(PRESENCE_THROTTLE_MS);
    expect(watcher.last).toMatchObject({ lookingForGame: 0 });
  });
});

describe('/ws/presence + /api/stats (integration)', () => {
  let srv: RunningServer;
  let base: string;
  const sockets: TestSocket[] = [];

  function presenceSock(headers?: Record<string, string>) {
    const s = new TestSocket(base + '/ws/presence', headers);
    sockets.push(s);
    return s;
  }
  type Counts = Extract<PresenceS2C, { t: 'counts' }>;
  const isCounts =
    (p: (c: Counts) => boolean = () => true) =>
    (m: S2C) => {
      const x = m as unknown as PresenceS2C;
      return x.t === 'counts' && p(x);
    };

  async function guestCookie(): Promise<string> {
    const r = await srv.app.inject('/api/me');
    const set = r.headers['set-cookie'];
    const raw = Array.isArray(set) ? set[0]! : set!;
    return raw.split(';')[0]!;
  }

  beforeAll(async () => {
    srv = await startServer(testConfig({ clipsDir: makeClipsDir(3) }));
    base = srv.url.replace('http', 'ws');
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await srv.close();
  });

  it('pushes counts, counts a cookie user once across two tabs, and serves /api/stats', async () => {
    const watcher = presenceSock();
    await watcher.wait(isCounts((c) => c.online === 1));

    const cookie = await guestCookie();
    const tab1 = presenceSock({ cookie });
    const tab2 = presenceSock({ cookie });
    await tab1.opened;
    await tab2.opened;
    await watcher.wait(isCounts((c) => c.online === 2));
    expect(srv.presence.counts().online).toBe(2);

    // Same user joins a room over the game socket: still 2.
    const r = await srv.app.inject({ method: 'POST', url: '/api/rooms', payload: { name: 'Al' } });
    const { code, token } = r.json() as { code: string; token: string };
    const room = new TestSocket(base + '/ws', { cookie });
    sockets.push(room);
    await room.opened;
    room.send({ t: 'hello', v: PROTOCOL_VERSION, code, token });
    await room.wait((m) => m.t === 'welcome');
    expect(srv.presence.counts()).toMatchObject({ online: 2, inGame: 0 });

    const stats = await srv.app.inject('/api/stats');
    expect(stats.statusCode).toBe(200);
    expect(stats.json()).toEqual({ online: 2, inGame: 0, rooms: 1 });

    // An anonymous room player is one more.
    const anon = new TestSocket(base + '/ws');
    sockets.push(anon);
    await anon.opened;
    anon.send({ t: 'hello', v: PROTOCOL_VERSION, code, name: 'Bo' });
    await anon.wait((m) => m.t === 'welcome');
    await watcher.wait(isCounts((c) => c.online === 3));

    anon.close();
    await anon.closed;
    await watcher.wait(isCounts((c) => c.online === 2));
  });

  it('answers ping, rejects junk and foreign origins', async () => {
    const s = presenceSock();
    await s.opened;
    s.send({ t: 'ping', c: 42 });
    await s.wait((m) => (m as unknown as PresenceS2C).t === 'pong');
    s.send({ t: 'nope' });
    await s.wait((m) => m.t === 'error');
    const bad = new TestSocket(base + '/ws/presence', { origin: 'https://evil.example' });
    await expect(bad.opened).rejects.toThrow(/403/);
  });
});
