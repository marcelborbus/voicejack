import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS, paths, type Limits } from '@dub/shared';
import type { FastifyInstance } from 'fastify';
import { ClipLibrary, toClipInfo } from '../src/clips/ClipLibrary.js';
import { buildApp } from '../src/http/app.js';
import { RoomManager } from '../src/room/RoomManager.js';
import type { Room } from '../src/room/Room.js';
import { ChunkStore } from '../src/uploads/ChunkStore.js';
import { normalizeMime } from '../src/routes/chunks.js';
import { makeClipsDir, testConfig, tmpDir } from './helpers.js';

const MIME = 'audio/webm;codecs=opus';
const smallLimits: Limits = {
  ...LIMITS,
  maxChunkBytes: 1000,
  maxSubmissionBytes: 2500,
  maxChunksPerSubmission: 4,
};

let app: FastifyInstance;
let rooms: RoomManager;
let store: ChunkStore;
let room: Room;
let host: { playerId: string; token: string };
let guest: { playerId: string; token: string };
let outsider: { token: string };

const up = (
  token: string | undefined,
  chunkId: string,
  body: Buffer | string = Buffer.alloc(100, 1),
  round = 0,
  mime = MIME,
) =>
  app.inject({
    method: 'POST',
    url: paths.chunkUpload(room.code, round, chunkId),
    headers: { 'content-type': mime, ...(token ? { 'x-player-token': token } : {}) },
    payload: body,
  });

const sub = (pid: string) => room.snapshotFor(pid)!.you.submissionId!;

beforeAll(async () => {
  const clipsDir = makeClipsDir(3);
  const clips = ClipLibrary.load(clipsDir);
  const config = testConfig({ clipsDir });
  store = new ChunkStore(tmpDir('dub-store-'), { limits: smallLimits });
  await store.init();
  rooms = new RoomManager({ config, clips: clips.clips.map(toClipInfo), store });
  app = await buildApp({ config, clips, rooms, store });
  const r = rooms.create('Host');
  if ('message' in r) throw new Error(r.message);
  room = r.room;
  host = r.join;
  const g = room.join('Guest');
  if ('message' in g) throw new Error(g.message);
  guest = g;
  const other = rooms.create('Other');
  if ('message' in other) throw new Error(other.message);
  outsider = other.join;
  for (const p of [host, guest]) {
    room.connect(p.playerId);
    room.handle(p.playerId, { t: 'micStatus', ok: true });
    room.handle(p.playerId, { t: 'setReady', ready: true });
  }
});
afterAll(async () => {
  await app.close();
  await rooms.stop();
});

describe('chunk upload', () => {
  it('409 outside DUBBING', async () => {
    const r = await up(host.token, 'early');
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'BAD_PHASE' });
    expect(room.handle(host.playerId, { t: 'startGame' })).toBeNull();
  });

  it('201 and idempotent overwrite', async () => {
    const r = await up(host.token, 'c1', Buffer.alloc(300, 7));
    expect(r.statusCode).toBe(201);
    expect(r.json()).toEqual({ id: 'c1', bytes: 300 });
    const again = await up(host.token, 'c1', Buffer.alloc(200, 8));
    expect(again.json()).toEqual({ id: 'c1', bytes: 200 });
    expect(store.usage(room.code, sub(host.playerId))).toEqual({ bytes: 200, count: 1 });
    expect(store.isUploaded(room.code, sub(host.playerId), 'c1')).toBe(true);
    const file = path.join(store.dir, room.code, '0', sub(host.playerId), 'c1');
    expect(fs.readFileSync(file)).toEqual(Buffer.alloc(200, 8));
    expect(fs.readdirSync(path.dirname(file))).toEqual(['c1']); // no tmp left behind
  });

  it('accepts all three mimes (with parameter spacing)', async () => {
    expect(
      (await up(guest.token, 'g1', Buffer.alloc(50), 0, 'audio/ogg; codecs=opus')).statusCode,
    ).toBe(201);
    expect((await up(guest.token, 'g2', Buffer.alloc(50), 0, 'audio/mp4')).statusCode).toBe(201);
    expect(normalizeMime('audio/webm;codecs="opus"')).toBe(MIME);
  });

  it('401 without or with a foreign token', async () => {
    expect((await up(undefined, 'x')).statusCode).toBe(401);
    const r = await up(outsider.token, 'x');
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ error: 'BAD_TOKEN' });
  });

  it('409 for another round, 400 bad id, 415 bad mime, 400 empty body, 404 unknown room', async () => {
    expect((await up(host.token, 'x', undefined, 1)).statusCode).toBe(409);
    expect((await up(host.token, 'bad.id')).statusCode).toBe(400);
    expect((await up(host.token, 'x', undefined, 0, 'audio/wav')).statusCode).toBe(415);
    expect((await up(host.token, 'x', Buffer.alloc(0))).statusCode).toBe(400);
    const r = await app.inject({
      method: 'POST',
      url: paths.chunkUpload('ZZZZZZ', 0, 'x'),
      headers: { 'content-type': MIME, 'x-player-token': host.token },
      payload: Buffer.alloc(10),
    });
    expect(r.statusCode).toBe(404);
  });

  it('413 over maxChunkBytes, submission total, and chunk count', async () => {
    const big = await up(host.token, 'big', Buffer.alloc(LIMITS.maxChunkBytes + 1));
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ error: 'LIMIT' });
    const over = await up(host.token, 'big2', Buffer.alloc(smallLimits.maxChunkBytes + 1));
    expect(over.statusCode).toBe(413);
    // host has c1 (200 bytes); add up to 2500 total
    expect((await up(host.token, 'c2', Buffer.alloc(1000))).statusCode).toBe(201);
    expect((await up(host.token, 'c3', Buffer.alloc(1000))).statusCode).toBe(201);
    expect((await up(host.token, 'c4', Buffer.alloc(400))).statusCode).toBe(413); // 2600 > 2500
    expect((await up(host.token, 'c4', Buffer.alloc(100))).statusCode).toBe(201); // 2300, 4 chunks
    expect((await up(host.token, 'c5', Buffer.alloc(10))).statusCode).toBe(413); // count
    expect((await up(host.token, 'c4', Buffer.alloc(300))).statusCode).toBe(201); // overwrite ok
  });
});

describe('chunk download', () => {
  const get = (token: string | undefined, subId: string, chunkId: string, viaQuery = false) =>
    app.inject({
      url:
        paths.chunk(room.code, 0, subId, chunkId) +
        (viaQuery && token ? `?k=${encodeURIComponent(token)}` : ''),
      headers: token && !viaQuery ? { 'x-player-token': token } : {},
    });

  it('owner-only during DUBBING', async () => {
    const own = await get(host.token, sub(host.playerId), 'c1');
    expect(own.statusCode).toBe(200);
    expect(own.headers['content-type']).toBe(MIME);
    expect(own.rawPayload).toEqual(Buffer.alloc(200, 8));
    const viaQuery = await get(host.token, sub(host.playerId), 'c1', true);
    expect(viaQuery.statusCode).toBe(200);
    const other = await get(guest.token, sub(host.playerId), 'c1');
    expect(other.statusCode).toBe(403);
    expect(other.json()).toMatchObject({ error: 'BAD_PHASE' });
    expect((await get(undefined, sub(host.playerId), 'c1')).statusCode).toBe(401);
    expect((await get(host.token, sub(host.playerId), 'nope')).statusCode).toBe(404);
  });

  it('members can GET after finalize; uploads then closed', async () => {
    const hostSub = sub(host.playerId);
    const guestSub = sub(guest.playerId);
    room.handle(host.playerId, {
      t: 'manifest',
      round: 0,
      chunks: [{ id: 'c1', startMs: 0, offsetMs: 0, durationMs: 1000, mime: MIME, bytes: 300 }],
    });
    room.handle(host.playerId, { t: 'dubDone', round: 0, done: true });
    room.handle(guest.playerId, { t: 'dubDone', round: 0, done: true });
    // still within upload grace
    expect((await up(guest.token, 'late', Buffer.alloc(10))).statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, testConfig().timings.uploadGraceMs + 100));
    expect(room.currentPhase).toBe('SHOWCASE');
    const r = await get(guest.token, hostSub, 'c1');
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload).toEqual(Buffer.alloc(200, 8));
    expect((await get(host.token, guestSub, 'g1')).statusCode).toBe(200);
    expect((await get(outsider.token, hostSub, 'c1')).statusCode).toBe(401);
    expect((await up(guest.token, 'later', Buffer.alloc(10))).statusCode).toBe(409);
  });

  it('deleteRoom removes files and index', async () => {
    const hostSub = sub(host.playerId);
    await rooms.dispose(room.code);
    expect(store.isUploaded(room.code, hostSub, 'c1')).toBe(false);
    expect(fs.existsSync(path.join(store.dir, room.code))).toBe(false);
  });
});

describe('ChunkStore.init', () => {
  it('wipes the data dir', async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'OLD'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'OLD', 'x'), 'x');
    await new ChunkStore(dir).init();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
