import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type S2C } from '@dub/shared';
import { startServer, type RunningServer } from '../src/bootstrap.js';
import { ROOM_EMPTY_TTL_MS, ROOM_MAX_AGE_MS, RoomManager } from '../src/room/RoomManager.js';
import { makeClipsDir, testConfig } from './helpers.js';
import { TestSocket } from './wsClient.js';

let srv: RunningServer;
let wsUrl: string;
const sockets: TestSocket[] = [];

function sock(headers?: Record<string, string>) {
  const s = new TestSocket(wsUrl, headers);
  sockets.push(s);
  return s;
}

async function createRoom(name = 'Host') {
  const r = await srv.app.inject({ method: 'POST', url: '/api/rooms', payload: { name } });
  expect(r.statusCode).toBe(201);
  return r.json() as { code: string; playerId: string; token: string };
}

async function hello(s: TestSocket, m: Record<string, unknown>) {
  await s.opened;
  s.send({ t: 'hello', v: PROTOCOL_VERSION, ...m });
  return s.wait<Extract<S2C, { t: 'welcome' | 'error' }>>(
    (x) => x.t === 'welcome' || x.t === 'error',
  );
}

beforeAll(async () => {
  srv = await startServer(testConfig({ clipsDir: makeClipsDir(3), maxRooms: 3 }));
  wsUrl = srv.url.replace('http', 'ws') + '/ws';
});
afterAll(async () => {
  for (const s of sockets) s.close();
  await srv.close();
});

describe('rooms REST', () => {
  it('creates and describes a room', async () => {
    const c = await createRoom();
    expect(c.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(c.token.length).toBeGreaterThanOrEqual(32);
    const info = await srv.app.inject(`/api/rooms/${c.code}`);
    expect(info.json()).toEqual({
      code: c.code,
      phase: 'LOBBY',
      playerCount: 1,
      maxPlayers: 8,
      joinable: true,
    });
    expect((await srv.app.inject(`/api/rooms/${c.code.toLowerCase()}`)).statusCode).toBe(200);
  });

  it('404 for unknown room, 400 for bad name', async () => {
    const r = await srv.app.inject('/api/rooms/ZZZZZZ');
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: 'ROOM_NOT_FOUND' });
    const b = await srv.app.inject({ method: 'POST', url: '/api/rooms', payload: { name: '   ' } });
    expect(b.statusCode).toBe(400);
    expect(b.json()).toMatchObject({ error: 'INVALID' });
  });

  it('MAX_ROOMS → 503 ROOM_FULL; create is rate limited', async () => {
    // maxRooms 3: 1 from the first test, so 2 more succeed
    await createRoom();
    await createRoom();
    const full = await srv.app.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: { name: 'x' },
    });
    expect(full.statusCode).toBe(503);
    expect(full.json()).toMatchObject({ error: 'ROOM_FULL' });
    const limited = await srv.app.inject({
      method: 'POST',
      url: '/api/rooms',
      payload: { name: 'x' },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'RATE_LIMITED' });
    for (const code of srv.rooms.codes()) await srv.rooms.dispose(code);
  });
});

describe('WS gateway', () => {
  it('hello, broadcast, relay, ping, bad message, reconnect, ROOM_FULL', async () => {
    const room = srv.rooms.create('Host');
    if ('message' in room) throw new Error(room.message);
    const code = room.room.code;
    const host = room.join;

    const a = sock();
    const wa = await hello(a, { code, token: host.token });
    expect(wa).toMatchObject({
      t: 'welcome',
      playerId: host.playerId,
      token: host.token,
      v: PROTOCOL_VERSION,
    });
    if (wa.t !== 'welcome') throw new Error();
    expect(wa.iceServers[0]!.urls).toContain('stun:');
    expect(wa.limits.maxPlayers).toBe(8);
    await a.state((s) => s.players.length === 1 && s.players[0]!.connected);

    const b = sock();
    const wb = await hello(b, { code, name: 'Bob' });
    if (wb.t !== 'welcome') throw new Error(JSON.stringify(wb));
    expect(wb.playerId).not.toBe(host.playerId);
    const sa = await a.state((s) => s.players.length === 2);
    expect(sa.players.map((p) => p.name)).toEqual(['Host', 'Bob']);
    expect(sa.you.playerId).toBe(host.playerId);
    expect((await b.state()).you.playerId).toBe(wb.playerId);

    // game message → broadcast
    b.send({ t: 'micStatus', ok: true });
    await a.state((s) => s.players[1]!.micOk);

    // rtc relay
    const signal = { kind: 'description', description: { type: 'offer', sdp: 'v=0' } } as const;
    a.send({ t: 'rtc', to: wb.playerId, data: signal });
    expect(await b.wait((m) => m.t === 'rtc')).toEqual({
      t: 'rtc',
      from: host.playerId,
      data: signal,
    });
    a.send({ t: 'rtc', to: 'nobody', data: signal });
    expect(await a.wait((m) => m.t === 'error' && m.code === 'INVALID')).toBeTruthy();

    // ping/pong
    a.send({ t: 'ping', c: 123.5 });
    const pong = await a.wait((m) => m.t === 'pong');
    expect(pong).toMatchObject({ t: 'pong', c: 123.5 });

    // bad message → INVALID (not fatal)
    const n = b.received.length;
    b.send({ t: 'vote', score: 99 });
    b.ws.send('not json');
    const e = await b.wait((m) => m.t === 'error', 3000, n);
    expect(e).toMatchObject({ t: 'error', code: 'INVALID' });
    expect('fatal' in e && e.fatal).toBeFalsy();
    // domain errors reach the sender
    b.send({ t: 'startGame' });
    await b.wait((m) => m.t === 'error' && m.code === 'NOT_HOST');

    // token reconnect: new socket replaces the old one, same player
    const b2 = sock();
    const wb2 = await hello(b2, { code, token: wb.token });
    expect(wb2).toMatchObject({ t: 'welcome', playerId: wb.playerId });
    const closed = await b.closed;
    expect(closed.code).toBe(4000);
    const after = await a.state((s) => s.players.length === 2 && s.players[1]!.connected);
    expect(after.players[1]!.micOk).toBe(true);

    // disconnect → connected:false
    b2.close();
    await a.state((s) => s.players[1]!.connected === false);
    const b3 = sock();
    await hello(b3, { code, token: wb.token });
    await a.state((s) => s.players[1]!.connected === true);

    // fill to 8, then the 9th gets ROOM_FULL (fatal)
    for (let i = 0; i < 6; i++) {
      const w = await hello(sock(), { code, name: `P${i}` });
      expect(w.t).toBe('welcome');
    }
    const ninth = sock();
    const e9 = await hello(ninth, { code, name: 'Ninth' });
    expect(e9).toMatchObject({ t: 'error', code: 'ROOM_FULL', fatal: true });
    await ninth.closed;
    await srv.rooms.dispose(code);
  });

  it('rejects unknown room, bad version, bad token, missing hello', async () => {
    const r = srv.rooms.create('H');
    if ('message' in r) throw new Error(r.message);
    const code = r.room.code;
    expect(await hello(sock(), { code: 'ZZZZZZ', name: 'x' })).toMatchObject({
      code: 'ROOM_NOT_FOUND',
      fatal: true,
    });
    expect(await hello(sock(), { code, name: 'x', v: 999 })).toMatchObject({
      code: 'VERSION',
      fatal: true,
    });
    expect(await hello(sock(), { code, token: 'nope' })).toMatchObject({
      code: 'BAD_TOKEN',
      fatal: true,
    });
    const s = sock();
    await s.opened;
    s.send({ t: 'setReady', ready: true });
    expect(await s.wait((m) => m.t === 'error')).toMatchObject({ code: 'INVALID' });
    await srv.rooms.dispose(code);
  });

  it('kick closes the kicked socket', async () => {
    const r = srv.rooms.create('H');
    if ('message' in r) throw new Error(r.message);
    const code = r.room.code;
    const h = sock();
    await hello(h, { code, token: r.join.token });
    const v = sock();
    const wv = await hello(v, { code, name: 'Victim' });
    if (wv.t !== 'welcome') throw new Error();
    h.send({ t: 'kick', playerId: wv.playerId });
    expect(await v.wait((m) => m.t === 'kicked')).toEqual({ t: 'kicked' });
    expect((await v.closed).code).toBe(4001);
    await h.state((s) => s.players.length === 1);
    await srv.rooms.dispose(code);
  });

  it('rejects cross-origin upgrades', async () => {
    const s = new TestSocket(wsUrl, { Origin: 'https://evil.example' });
    await expect(s.opened).rejects.toThrow(/403/);
    const ok = sock({ Origin: srv.url });
    await ok.opened;
  });

  it('rate limit closes a flooding socket', async () => {
    const s = sock();
    await s.opened;
    for (let i = 0; i < 200; i++) s.send({ t: 'ping', c: i });
    expect(await s.wait((m) => m.t === 'error' && m.code === 'RATE_LIMITED')).toBeTruthy();
    expect((await s.closed).code).toBe(1008);
  });

  it('oversized frames close the socket', async () => {
    const s = sock();
    await s.opened;
    s.ws.send('x'.repeat(40 * 1024));
    expect((await s.closed).code).toBe(1009);
  });

  it('disposal closes sockets with fatal ROOM_NOT_FOUND', async () => {
    const r = srv.rooms.create('H');
    if ('message' in r) throw new Error(r.message);
    const s = sock();
    await hello(s, { code: r.room.code, token: r.join.token });
    await srv.rooms.dispose(r.room.code);
    expect(await s.wait((m) => m.t === 'error')).toMatchObject({
      code: 'ROOM_NOT_FOUND',
      fatal: true,
    });
    expect((await s.closed).code).toBe(4004);
  });
});

describe('RoomManager disposal', () => {
  it('disposes rooms empty for 10 min or older than 3 h and deletes uploads', async () => {
    let now = 1_000_000;
    const deleted: string[] = [];
    const m = new RoomManager({
      config: testConfig(),
      clips: [],
      clock: { now: () => now },
      scheduler: { setTimeout: () => 0, clearTimeout: () => {} },
      store: { isUploaded: () => false, deleteRoom: (c) => void deleted.push(c) },
    });
    const r1 = m.create('A');
    const r2 = m.create('B');
    if ('message' in r1 || 'message' in r2) throw new Error();
    const sent: unknown[] = [];
    m.attach(r2.room.code, r2.join.playerId, { send: (x) => sent.push(x), close: () => {} });
    r2.room.connect(r2.join.playerId);
    now += ROOM_EMPTY_TTL_MS - 1;
    expect(await m.sweep()).toEqual([]);
    now += 1;
    expect(await m.sweep()).toEqual([r1.room.code]);
    expect(deleted).toEqual([r1.room.code]);
    expect(m.stats()).toEqual({ rooms: 1, players: 1 });
    now += ROOM_MAX_AGE_MS;
    expect(await m.sweep()).toEqual([r2.room.code]);
    expect(sent.at(-1)).toMatchObject({ t: 'error', code: 'ROOM_NOT_FOUND', fatal: true });
    expect(m.size).toBe(0);
  });
});
