import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  USER_MAX_BYTES,
  USER_MAX_CLIPS,
  USER_UPLOADS_PER_DAY,
  type AdminClip,
  type AdminUserLibrariesResponse,
  type LibrariesResponse,
  type MyLibrariesResponse,
} from '@dub/shared';
import { ClipLibrary } from '../src/clips/ClipLibrary.js';
import { hostLibraries } from '../src/clips/HostLibraries.js';
import { JobQueue, hasFfmpeg } from '../src/clips/normalize.js';
import { openDb, type Db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { Accounts } from '../src/accounts/Accounts.js';
import { SESSION_COOKIE } from '../src/accounts/cookies.js';
import { buildApp } from '../src/http/app.js';
import { RoomManager } from '../src/room/RoomManager.js';
import type { Room } from '../src/room/Room.js';
import { makeClipsDir, testConfig, tmpDir } from './helpers.js';

const ADMIN = { 'remote-user': 'marcel', 'remote-groups': 'admins' };

interface Env {
  app: FastifyInstance;
  db: Db;
  clips: ClipLibrary;
  accounts: Accounts;
  rooms: RoomManager;
  libraryDir: string;
}

async function setup(): Promise<Env> {
  const clipsDir = makeClipsDir(2);
  const db = openDb(':memory:');
  migrate(db);
  const libraryDir = tmpDir('vj-lib-');
  const clips = ClipLibrary.open(db, { clipsDir, libraryDir });
  const accounts = new Accounts(db);
  const config = testConfig({ clipsDir, libraryDir, trustProxy: '127.0.0.1' });
  const rooms = new RoomManager({ config, clips: [], library: clips });
  clips.onChange(() => rooms.libraryChanged());
  const app = await buildApp({ config, clips, accounts, rooms });
  return { app, db, clips, accounts, rooms, libraryDir };
}

/** A user with a session; returns its id and a `Cookie:` header value. */
function user(env: Env, kind: 'guest' | 'registered' = 'registered', name = 'Ann') {
  const u = env.accounts.createGuest();
  if (kind === 'registered') {
    env.db
      .prepare("UPDATE users SET kind = 'registered', email = ?, display_name = ? WHERE id = ?")
      .run(`${u.id.toLowerCase()}@example.com`, name, u.id);
  }
  const { token } = env.accounts.createSession(u.id);
  return { id: u.id, cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` };
}

/** A "ready" clip uploaded by `userId` without ffmpeg (dummy bytes). */
function fakeClip(env: Env, libraryId: string, userId: string, bytes = 2048, title = 'Mine') {
  const up = env.clips.createUpload(libraryId, {
    title,
    tags: ['mine'],
    attribution: { author: '', source: '', license: '' },
    uploadedBy: userId,
    rightsConfirmedAt: Date.now(),
  });
  fs.writeFileSync(path.join(env.clips.uploadDir(libraryId), up.file), Buffer.alloc(2048, 3));
  return env.clips.finishUpload(up.id, {
    durationMs: 5000,
    width: 320,
    height: 240,
    bytes,
    poster: false,
  });
}

async function createLib(env: Env, cookie: string, name = 'Lib') {
  const r = await env.app.inject({
    method: 'POST',
    url: '/api/my/libraries',
    headers: { cookie },
    payload: { name },
  });
  return r;
}

/** Room hosted by `hostUserId` (linked like the gateway does on hello). */
function hostRoom(env: Env, hostUserId: string): { room: Room; hostId: string } {
  const c = env.rooms.create('Host');
  if ('code' in c && !('room' in c)) throw new Error(c.message);
  const { room, join } = c as { room: Room; join: { playerId: string } };
  room.linkUser(join.playerId, hostUserId);
  room.connect(join.playerId);
  return { room, hostId: join.playerId };
}

function joinRoom(room: Room, userId: string, name = 'Guest'): string {
  const j = room.join(name);
  if ('code' in j) throw new Error(j.message);
  room.linkUser(j.playerId, userId);
  room.connect(j.playerId);
  return j.playerId;
}

const pick = (room: Room, playerId: string, libraryId: string) =>
  room.handle(playerId, { t: 'updateSettings', settings: { libraryId } });
const selected = (room: Room, playerId: string) => room.snapshotFor(playerId)!.settings.libraryId;

describe('host libraries: access + quotas', async () => {
  const env = await setup();
  afterAll(() => env.app.close());

  it('only registered users manage libraries', async () => {
    expect((await env.app.inject('/api/my/libraries')).statusCode).toBe(401);
    const guest = user(env, 'guest');
    expect((await createLib(env, guest.cookie)).statusCode).toBe(403);
    const ann = user(env);
    const r = await env.app.inject({ url: '/api/my/libraries', headers: { cookie: ann.cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json<MyLibrariesResponse>()).toMatchObject({
      libraries: [],
      quota: { libraries: 0, maxLibraries: 5, clips: 0, maxClips: 30, uploadBanned: false },
    });
  });

  it('at most 5 libraries per user', async () => {
    const bob = user(env);
    for (let i = 0; i < 5; i++)
      expect((await createLib(env, bob.cookie, `L${i}`)).statusCode).toBe(201);
    const sixth = await createLib(env, bob.cookie, 'L6');
    expect(sixth.statusCode).toBe(403);
    expect(sixth.json().message).toMatch(/at most 5/);
  });

  it('refuses uploads over the clip, storage, daily and ban limits (before reading the body)', async () => {
    const upload = (cookie: string, libId: string) =>
      env.app.inject({
        method: 'POST',
        url: `/api/my/libraries/${libId}/clips?title=x&rights=1`,
        headers: { cookie, 'content-type': 'application/octet-stream' },
        payload: Buffer.alloc(10),
      });
    const host = hostLibraries(env.clips);

    const c = user(env);
    const libC = (await createLib(env, c.cookie)).json().library.id as string;
    for (let i = 0; i < USER_MAX_CLIPS; i++) fakeClip(env, libC, c.id);
    const r1 = await upload(c.cookie, libC);
    expect(r1.statusCode).toBe(403);
    expect(r1.json().message).toMatch(/30 clips/);

    const d = user(env);
    const libD = (await createLib(env, d.cookie)).json().library.id as string;
    fakeClip(env, libD, d.id, USER_MAX_BYTES);
    expect((await upload(d.cookie, libD)).json().message).toMatch(/300 MB/);
    expect(host.storageExceeded(d.id)).toBeNull();
    fakeClip(env, libD, d.id, 1);
    expect(host.storageExceeded(d.id)).toMatch(/exceeded/);

    const e = user(env);
    const libE = (await createLib(env, e.cookie)).json().library.id as string;
    for (let i = 0; i < USER_UPLOADS_PER_DAY; i++) host.recordUpload(e.id);
    expect((await upload(e.cookie, libE)).json().message).toMatch(/per day/);

    const f = user(env);
    const libF = (await createLib(env, f.cookie)).json().library.id as string;
    const missingRights = await env.app.inject({
      method: 'POST',
      url: `/api/my/libraries/${libF}/clips?title=x`,
      headers: { cookie: f.cookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(10),
    });
    expect(missingRights.statusCode).toBe(400);
    expect(missingRights.json().message).toMatch(/rights/);
    host.setUploadBanned(f.id, true);
    const banned = await upload(f.cookie, libF);
    expect(banned.statusCode).toBe(403);
    expect(banned.json().message).toMatch(/disabled for your account/);
    const q = await env.app.inject({ url: '/api/my/libraries', headers: { cookie: f.cookie } });
    expect(q.json<MyLibrariesResponse>().quota.uploadBanned).toBe(true);
  });

  it('users only see and change their own libraries and clips', async () => {
    const ann = user(env);
    const eve = user(env);
    const lib = (await createLib(env, ann.cookie, 'Ann lib')).json().library.id as string;
    const clip = fakeClip(env, lib, ann.id);
    const as = (
      cookie: string,
      method: 'GET' | 'PATCH' | 'DELETE',
      url: string,
      payload?: object,
    ) => env.app.inject({ method, url, headers: { cookie }, payload });

    expect((await as(eve.cookie, 'GET', `/api/my/libraries/${lib}/clips`)).statusCode).toBe(404);
    expect(
      (await as(eve.cookie, 'PATCH', `/api/my/clips/${clip.id}`, { title: 'X' })).statusCode,
    ).toBe(404);
    expect((await as(eve.cookie, 'DELETE', `/api/my/clips/${clip.id}`)).statusCode).toBe(404);
    expect((await as(eve.cookie, 'DELETE', `/api/my/libraries/${lib}`)).statusCode).toBe(404);
    // Official clips are not "mine" either.
    expect((await as(ann.cookie, 'PATCH', '/api/my/clips/clip-0', { title: 'X' })).statusCode).toBe(
      404,
    );

    const ok = await as(ann.cookie, 'PATCH', `/api/my/clips/${clip.id}`, {
      title: 'Renamed',
      tags: ['a'],
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().clip).toMatchObject({ title: 'Renamed', tags: ['a'], uploadedBy: ann.id });
    const list = await as(ann.cookie, 'GET', `/api/my/libraries/${lib}/clips`);
    expect(list.json().clips.map((c: AdminClip) => c.id)).toEqual([clip.id]);

    // The lobby list: official + own.
    const annList = (
      await env.app.inject({ url: '/api/libraries', headers: { cookie: ann.cookie } })
    ).json<LibrariesResponse>().libraries;
    expect(annList.map((l) => [l.id, l.visibility])).toEqual([
      ['classics', 'official'],
      [lib, 'private'],
    ]);
    const eveList = (
      await env.app.inject({ url: '/api/libraries', headers: { cookie: eve.cookie } })
    ).json<LibrariesResponse>().libraries;
    expect(eveList.map((l) => l.id)).toEqual(['classics']);

    expect((await as(ann.cookie, 'DELETE', `/api/my/clips/${clip.id}`)).statusCode).toBe(204);
    expect(env.clips.clipMeta(clip.id)).toBeNull();
    expect((await as(ann.cookie, 'DELETE', `/api/my/libraries/${lib}`)).statusCode).toBe(204);
    expect(env.clips.access(lib)).toBeNull();
  });
});

describe('host libraries in rooms', async () => {
  const env = await setup();
  afterAll(() => env.app.close());

  it('only the owner can pick a private library, and only while hosting', async () => {
    const ann = user(env);
    const eve = user(env);
    const lib = env.clips.createLibrary({ name: 'Ann' }, { userId: ann.id, visibility: 'private' });
    fakeClip(env, lib.id, ann.id);

    // Non-owner host: rejected.
    const r1 = hostRoom(env, eve.id);
    expect(pick(r1.room, r1.hostId, lib.id)).toMatchObject({ code: 'INVALID' });
    // A non-host owner cannot pick it either.
    const annInR1 = joinRoom(r1.room, ann.id, 'Ann');
    expect(pick(r1.room, annInR1, lib.id)).toMatchObject({ code: 'NOT_HOST' });

    // Owner host: fine, clip count follows.
    const r2 = hostRoom(env, ann.id);
    const eveInR2 = joinRoom(r2.room, eve.id, 'Eve');
    expect(pick(r2.room, r2.hostId, lib.id)).toBeNull();
    expect(selected(r2.room, eveInR2)).toBe(lib.id);
    expect(r2.room.snapshotFor(eveInR2)!.clipCount).toBe(1);

    // The owner leaves; the new host does not own it, so the room falls back to the default.
    r2.room.leave(r2.hostId);
    expect(selected(r2.room, eveInR2)).toBe('classics');
  });

  it('a public (hostless) room can never use a private library', () => {
    const ann = user(env);
    const lib = env.clips.createLibrary({ name: 'Ann' }, { userId: ann.id, visibility: 'private' });
    expect(env.clips.canUse(lib.id, undefined)).toBe(false);
    expect(env.clips.canUse(lib.id, ann.id)).toBe(true);
    expect(env.clips.canUse('classics', undefined)).toBe(true);
    fakeClip(env, lib.id, ann.id);

    // A matchmade room plays the default library and nobody (not even the owner) can switch.
    const pub = env.rooms.createPublic();
    if ('code' in pub && !('handle' in pub)) throw new Error(pub.message);
    const room = pub as Room;
    const seat = room.seat('Ann', ann.id);
    if ('code' in seat) throw new Error(seat.message);
    room.connect(seat.playerId);
    expect(selected(room, seat.playerId)).toBe('classics');
    expect(pick(room, seat.playerId, lib.id)).toMatchObject({ code: 'NOT_HOST' });
    expect(selected(room, seat.playerId)).toBe('classics');
    expect(room.servesLibraryTo(ann.id, lib.id)).toBe(false);
  });

  it('serves private clip files only to the owner and to players of a room using the library', async () => {
    const ann = user(env);
    const bob = user(env, 'guest');
    const eve = user(env);
    const lib = env.clips.createLibrary({ name: 'Ann' }, { userId: ann.id, visibility: 'private' });
    const clip = fakeClip(env, lib.id, ann.id);
    expect(clip.url).toMatch(new RegExp(`^/clips/${lib.id}/[0-9a-f]{32}\\.mp4$`));
    expect(clip.url).not.toContain(clip.id);
    const get = (cookie?: string) =>
      env.app.inject({ url: clip.url!, headers: cookie ? { cookie } : {} });

    expect((await get()).statusCode).toBe(404);
    expect((await get(eve.cookie)).statusCode).toBe(404);
    expect((await get(bob.cookie)).statusCode).toBe(404);
    const own = await get(ann.cookie);
    expect(own.statusCode).toBe(200);
    expect(own.headers['cache-control']).toMatch(/^private/);

    const { room, hostId } = hostRoom(env, ann.id);
    joinRoom(room, bob.id, 'Bob');
    expect(pick(room, hostId, lib.id)).toBeNull();
    expect((await get(bob.cookie)).statusCode).toBe(200);
    expect((await get(eve.cookie)).statusCode).toBe(404);

    // Room switches back to an official library: members lose access.
    expect(pick(room, hostId, 'classics')).toBeNull();
    expect((await get(bob.cookie)).statusCode).toBe(404);
    // Official clips stay public.
    expect((await env.app.inject('/clips/classics/clip-0.mp4')).statusCode).toBe(200);
  });
});

describe('admin moderation of user libraries', async () => {
  const env = await setup();
  afterAll(() => env.app.close());
  const admin = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    env.app.inject({ method, url, headers: ADMIN, payload });

  it('lists private libraries with owner and clips, disables libraries, bans uploaders', async () => {
    const ann = user(env, 'registered', 'Ann');
    const lib = env.clips.createLibrary(
      { name: 'Ann lib' },
      { userId: ann.id, visibility: 'private' },
    );
    const c1 = fakeClip(env, lib.id, ann.id, 2048, 'One');
    const c2 = fakeClip(env, lib.id, ann.id, 2048, 'Two');

    // The official view does not mix in private libraries.
    const official = (await admin('GET', '/api/admin/libraries')).json().libraries;
    expect(official.map((l: { id: string }) => l.id)).toEqual(['classics']);

    const ov = (await admin('GET', '/api/admin/user-libraries')).json<AdminUserLibrariesResponse>();
    expect(ov.libraries).toHaveLength(1);
    expect(ov.libraries[0]).toMatchObject({
      id: lib.id,
      disabled: false,
      owner: { id: ann.id, displayName: 'Ann', uploadBanned: false },
    });
    expect(ov.libraries[0]!.owner!.email).toMatch(/@example\.com$/);
    expect(ov.libraries[0]!.clips.map((c) => [c.title, c.uploadedBy])).toEqual([
      ['One', ann.id],
      ['Two', ann.id],
    ]);
    expect(ov.libraries[0]!.clips[0]!.rightsConfirmedAt).toBeGreaterThan(0);
    // Admin preview of a private file (not served on /clips to admins).
    expect((await admin('GET', `/api/admin/clips/${c1.id}/video`)).statusCode).toBe(200);
    expect((await env.app.inject(`/api/admin/clips/${c1.id}/video`)).statusCode).toBe(403);

    // Disable / delete a clip with the existing clip endpoints.
    expect((await admin('PATCH', `/api/admin/clips/${c1.id}`, { enabled: false })).statusCode).toBe(
      200,
    );
    expect(env.clips.clipsOf(lib.id)!.map((c) => c.id)).toEqual([c2.id]);
    expect((await admin('DELETE', `/api/admin/clips/${c2.id}`)).statusCode).toBe(204);
    expect(env.clips.clipMeta(c2.id)).toBeNull();

    // Disable the library: not usable, not listed, files not served, even to the owner.
    const c3 = fakeClip(env, lib.id, ann.id, 2048, 'Three');
    const { room, hostId } = hostRoom(env, ann.id);
    expect(pick(room, hostId, lib.id)).toBeNull();
    const dis = await admin('POST', `/api/admin/libraries/${lib.id}/disabled`, { disabled: true });
    expect(dis.statusCode).toBe(200);
    expect(dis.json().library.disabled).toBe(true);
    expect(env.clips.canUse(lib.id, ann.id)).toBe(false);
    expect(selected(room, hostId)).toBe('classics');
    expect(
      (await env.app.inject({ url: c3.url!, headers: { cookie: ann.cookie } })).statusCode,
    ).toBe(404);
    const annList = (
      await env.app.inject({ url: '/api/libraries', headers: { cookie: ann.cookie } })
    ).json<LibrariesResponse>().libraries;
    expect(annList.map((l) => l.id)).toEqual(['classics']);
    expect(
      (await admin('POST', '/api/admin/libraries/classics/disabled', { disabled: true }))
        .statusCode,
    ).toBe(400);
    await admin('POST', `/api/admin/libraries/${lib.id}/disabled`, { disabled: false });
    expect(env.clips.canUse(lib.id, ann.id)).toBe(true);

    // Upload ban.
    const ban = await admin('POST', `/api/admin/users/${ann.id}/upload-ban`, { banned: true });
    expect(ban.statusCode).toBe(200);
    expect(hostLibraries(env.clips).uploadRefusal(ann.id)).toMatch(/disabled/);
    expect(
      (await admin('POST', '/api/admin/users/nobody/upload-ban', { banned: true })).statusCode,
    ).toBe(404);
    const ov2 = (
      await admin('GET', '/api/admin/user-libraries')
    ).json<AdminUserLibrariesResponse>();
    expect(ov2.libraries[0]!.owner!.uploadBanned).toBe(true);

    // Account deletion takes the private libraries along.
    const del = await env.app.inject({
      method: 'DELETE',
      url: '/api/me',
      headers: { cookie: ann.cookie },
    });
    expect(del.statusCode).toBe(200);
    expect(env.clips.access(lib.id)).toBeNull();
    expect(fs.existsSync(path.join(env.libraryDir, lib.id))).toBe(false);
  });

  it('players of a private room report its clips; admins see and resolve the reports', async () => {
    const ann = user(env, 'registered', 'Ann');
    const bob = user(env, 'guest', 'Bob');
    const eve = user(env);
    const lib = env.clips.createLibrary(
      { name: 'Ann lib' },
      { userId: ann.id, visibility: 'private' },
    );
    const clip = fakeClip(env, lib.id, ann.id, 2048, 'Dubious');
    const report = (cookie: string, reason = 'not theirs') =>
      env.app.inject({
        method: 'POST',
        url: `/api/clips/${clip.id}/report`,
        headers: { cookie },
        payload: { reason },
      });
    expect((await report(bob.cookie)).statusCode).toBe(404);
    const { room, hostId } = hostRoom(env, ann.id);
    joinRoom(room, bob.id, 'Bob');
    expect(pick(room, hostId, lib.id)).toBeNull();
    expect((await report(bob.cookie, '')).statusCode).toBe(400);
    const r = await report(bob.cookie);
    expect(r.statusCode).toBe(201);
    expect((await report(bob.cookie)).statusCode).toBe(409);
    expect((await report(eve.cookie)).statusCode).toBe(404);
    // Official clips cannot be reported this way.
    const official = await env.app.inject({
      method: 'POST',
      url: '/api/clips/clip-0/report',
      headers: { cookie: bob.cookie },
      payload: { reason: 'x' },
    });
    expect(official.statusCode).toBe(404);

    const row = env.db.prepare('SELECT * FROM reports WHERE clip_id = ?').get(clip.id) as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({
      room_code: room.code,
      reporter_user_id: bob.id,
      reported_user_id: ann.id,
      reason: 'not theirs',
    });
    const ov = (await admin('GET', '/api/admin/user-libraries')).json<AdminUserLibrariesResponse>();
    expect(ov.reports[0]).toMatchObject({
      clipId: clip.id,
      clipTitle: 'Dubious',
      resolvedAt: null,
    });
    const id = ov.reports[0]!.id;
    expect((await admin('POST', `/api/admin/reports/${id}/resolve`)).statusCode).toBe(204);
    expect((await admin('POST', `/api/admin/reports/${id}/resolve`)).statusCode).toBe(404);
  });
});

describe('JobQueue (shared admin + user queue)', () => {
  let order: string[];
  beforeEach(() => {
    order = [];
  });

  it('runs one at a time, admin jobs before queued user jobs, one job per user', async () => {
    const q = new JobQueue(5, 10, 1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = (name: string, wait?: Promise<void>) => async () => {
      if (wait) await wait;
      order.push(name);
    };
    const first = q.push(job('admin-1', gate));
    expect(q.push(job('user-a'), { priority: 'user', owner: 'a' })).not.toBeNull();
    expect(q.refusal({ priority: 'user', owner: 'a' })).toBe('owner');
    expect(q.push(job('user-a2'), { priority: 'user', owner: 'a' })).toBeNull();
    q.push(job('user-b'), { priority: 'user', owner: 'b' });
    q.push(job('admin-2'));
    expect(q.size).toBe(4);
    release();
    await first;
    await q.idle();
    expect(order).toEqual(['admin-1', 'admin-2', 'user-a', 'user-b']);
    expect(q.size).toBe(0);
    expect(q.push(job('user-a3'), { priority: 'user', owner: 'a' })).not.toBeNull();
    await q.idle();
  });

  it('caps admin and user jobs separately and survives throwing jobs', async () => {
    const q = new JobQueue(1, 2, 5);
    const never = new Promise<void>(() => {});
    q.push(() => never);
    expect(q.refusal()).toBe('busy');
    expect(q.push(async () => {}, { priority: 'user', owner: 'x' })).not.toBeNull();
    expect(q.push(async () => {}, { priority: 'user', owner: 'y' })).not.toBeNull();
    expect(q.refusal({ priority: 'user', owner: 'z' })).toBe('busy');

    const q2 = new JobQueue();
    const failing = q2.push(() => {
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');
    await expect(q2.push(async () => 7)).resolves.toBe(7);
  });
});

describe.skipIf(!hasFfmpeg())('user upload through the normalize pipeline (ffmpeg)', async () => {
  const env = await setup();
  afterAll(() => env.app.close());
  const input = path.join(tmpDir(), 'in.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=320x240:rate=10:duration=4',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=4',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-shortest',
    input,
  ]);

  it('normalizes, records the rights confirmation and counts the upload', async () => {
    const ann = user(env);
    const lib = (await createLib(env, ann.cookie)).json().library.id as string;
    const r = await env.app.inject({
      method: 'POST',
      url: `/api/my/libraries/${lib}/clips?title=Mine&ss=1&t=2&tags=home&rights=1`,
      headers: { cookie: ann.cookie, 'content-type': 'application/octet-stream' },
      payload: fs.readFileSync(input),
    });
    expect(r.statusCode).toBe(202);
    const id = r.json().clip.id as string;
    await env.clips.jobs.idle();
    const clip = env.clips.adminClip(id);
    expect(clip).toMatchObject({ status: 'ready', uploadedBy: ann.id, tags: ['home'] });
    expect(clip.rightsConfirmedAt).toBeGreaterThan(0);
    expect(hostLibraries(env.clips).quota(ann.id)).toMatchObject({ clips: 1, uploadsToday: 1 });
    expect(hostLibraries(env.clips).quota(ann.id).bytes).toBeGreaterThan(0);
    const file = await env.app.inject({ url: clip.url!, headers: { cookie: ann.cookie } });
    expect(file.statusCode).toBe(200);
  }, 60_000);
});
