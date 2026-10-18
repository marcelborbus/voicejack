import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LIMITS, type AdminClip, type LibrariesResponse } from '@dub/shared';
import { BUILTIN_LIBRARY_ID, ClipLibrary } from '../src/clips/ClipLibrary.js';
import { hasFfmpeg } from '../src/clips/normalize.js';
import { openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/http/app.js';
import { Room } from '../src/room/Room.js';
import { realScheduler } from '../src/room/timers.js';
import { TIMINGS_PRESETS, type Config } from '../src/config.js';
import { compileTrust } from '../src/security/trustedProxy.js';
import { makeClipsDir, testConfig, tmpDir } from './helpers.js';

const ADMIN = { 'remote-user': 'marcel', 'remote-groups': 'admins,users' };

function openLib(dbFile: string, clipsDir: string, libraryDir = tmpDir('vj-lib-')) {
  const db = openDb(dbFile);
  migrate(db);
  return { db, lib: ClipLibrary.open(db, { clipsDir, libraryDir }) };
}

/** Adds a "ready" uploaded clip without ffmpeg (dummy bytes). */
function fakeUpload(lib: ClipLibrary, libraryId: string, title: string, tags: string[] = []) {
  const up = lib.createUpload(libraryId, {
    title,
    tags,
    attribution: { author: 'me', source: 'own', license: 'CC0' },
  });
  fs.writeFileSync(path.join(lib.uploadDir(libraryId), up.file), Buffer.alloc(2048, 7));
  return lib.finishUpload(up.id, {
    durationMs: 5000,
    width: 320,
    height: 240,
    bytes: 2048,
    poster: false,
  });
}

describe('manifest import (V05)', () => {
  it('imports clips/manifest.json as the default official library, idempotently', () => {
    const clipsDir = makeClipsDir(3);
    const dbFile = path.join(tmpDir(), 'vj.sqlite');
    const a = openLib(dbFile, clipsDir);
    expect(a.lib.defaultId()).toBe(BUILTIN_LIBRARY_ID);
    expect(a.lib.summaries()).toEqual([
      expect.objectContaining({ id: 'classics', name: 'Classics', isDefault: true, clipCount: 3 }),
    ]);
    // Admin edits survive a restart (re-import).
    a.lib.updateClip('clip-0', { title: 'Renamed', enabled: false });
    a.db.close();

    const b = openLib(dbFile, clipsDir);
    expect(migrate(b.db).applied).toEqual([]);
    const counts = b.db.prepare('SELECT COUNT(*) AS n FROM clips').get() as { n: number };
    expect(counts.n).toBe(3);
    expect(b.db.prepare('SELECT COUNT(*) AS n FROM libraries').get()).toEqual({ n: 1 });
    const c0 = b.lib.adminClips('classics').find((c) => c.id === 'clip-0')!;
    expect(c0).toMatchObject({ title: 'Renamed', enabled: false, builtin: true, playable: false });
    expect(b.lib.clips.map((c) => c.id)).toEqual(['clip-1', 'clip-2']);
    expect(b.lib.get('clip-1')?.url).toBe('/clips/clip-1.mp4');
    b.db.close();
  });

  it('keeps another default library across restarts', () => {
    const clipsDir = makeClipsDir(1);
    const dbFile = path.join(tmpDir(), 'vj.sqlite');
    const a = openLib(dbFile, clipsDir);
    const other = a.lib.createLibrary({ name: 'Other' });
    a.lib.setDefault(other.id);
    a.db.close();
    const b = openLib(dbFile, clipsDir);
    expect(b.lib.defaultId()).toBe(other.id);
    b.db.close();
  });

  it('a missing manifest still yields the (empty) built-in library', () => {
    const lib = ClipLibrary.load(tmpDir());
    expect(lib.defaultId()).toBe('classics');
    expect(lib.size).toBe(0);
    expect(lib.warnings[0]).toMatch(/no manifest/);
  });
});

describe('trusted proxy matcher', () => {
  it('understands keywords, addresses and CIDRs', () => {
    const t = compileTrust('loopback,uniquelocal,203.0.113.0/24,2001:db8::1');
    expect(t('127.0.0.1')).toBe(true);
    expect(t('::ffff:172.18.0.1')).toBe(true);
    expect(t('::1')).toBe(true);
    expect(t('203.0.113.9')).toBe(true);
    expect(t('2001:db8::1')).toBe(true);
    expect(t('8.8.8.8')).toBe(false);
    expect(t(undefined)).toBe(false);
    expect(compileTrust(false)('127.0.0.1')).toBe(false);
    expect(compileTrust('127.0.0.1')('127.0.0.2')).toBe(false);
  });
});

async function adminApp(over: Partial<Config> = {}) {
  const clipsDir = makeClipsDir(2);
  const db = openDb(':memory:');
  migrate(db);
  const libraryDir = tmpDir('vj-lib-');
  const clips = ClipLibrary.open(db, { clipsDir, libraryDir });
  const config = testConfig({ clipsDir, libraryDir, trustProxy: '127.0.0.1', ...over });
  const app = await buildApp({ config, clips });
  return { app, clips, libraryDir };
}

describe('admin auth', async () => {
  const { app } = await adminApp();
  afterAll(() => app.close());

  it('accepts Authelia headers from the trusted proxy', async () => {
    const r = await app.inject({ url: '/api/admin/me', headers: ADMIN });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ user: 'marcel', groups: ['admins', 'users'], dev: false });
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it.each([
    ['no headers', {}, '127.0.0.1'],
    ['not in admins', { 'remote-user': 'jelena', 'remote-groups': 'users' }, '127.0.0.1'],
    ['no user', { 'remote-groups': 'admins' }, '127.0.0.1'],
    ['group prefix only', { 'remote-user': 'x', 'remote-groups': 'admins2' }, '127.0.0.1'],
    ['headers from an untrusted peer', ADMIN, '198.51.100.7'],
  ])('403: %s', async (_n, headers, remoteAddress) => {
    const r = await app.inject({ url: '/api/admin/libraries', headers, remoteAddress });
    expect(r.statusCode).toBe(403);
  });

  it('403 for a cross-origin write', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/libraries',
      headers: { ...ADMIN, origin: 'https://evil.example', host: 'voicejack.borbus.eu' },
      payload: { name: 'X' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('ADMIN_DEV=1 lets loopback in without headers, nobody else', async () => {
    const dev = await adminApp({ adminDev: true, trustProxy: false });
    try {
      const ok = await dev.app.inject({ url: '/api/admin/me' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ dev: true });
      const far = await dev.app.inject({ url: '/api/admin/me', remoteAddress: '198.51.100.7' });
      expect(far.statusCode).toBe(403);
    } finally {
      await dev.app.close();
    }
  });
});

describe('admin CRUD', async () => {
  const { app, clips } = await adminApp();
  afterAll(() => app.close());
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: ADMIN, payload });

  it('creates, renames, defaults and deletes libraries', async () => {
    const created = await call('POST', '/api/admin/libraries', { name: 'Anime', description: 'd' });
    expect(created.statusCode).toBe(201);
    const id = created.json().library.id as string;
    expect(created.json().library).toMatchObject({ name: 'Anime', visibility: 'official' });

    expect((await call('POST', '/api/admin/libraries', { name: '' })).statusCode).toBe(400);
    const renamed = await call('PATCH', `/api/admin/libraries/${id}`, { name: 'Anime 2' });
    expect(renamed.json().library.name).toBe('Anime 2');

    const list = await call('GET', '/api/admin/libraries');
    expect(list.json().libraries.map((l: { id: string }) => l.id)).toEqual(['classics', id]);

    expect((await call('POST', `/api/admin/libraries/${id}/default`)).statusCode).toBe(200);
    expect(clips.defaultId()).toBe(id);
    // The default and the built-in library cannot be deleted.
    expect((await call('DELETE', `/api/admin/libraries/${id}`)).statusCode).toBe(409);
    await call('POST', '/api/admin/libraries/classics/default');
    expect((await call('DELETE', '/api/admin/libraries/classics')).statusCode).toBe(409);
    expect((await call('DELETE', `/api/admin/libraries/${id}`)).statusCode).toBe(204);
    expect((await call('DELETE', `/api/admin/libraries/${id}`)).statusCode).toBe(404);
  });

  it('edits, disables and deletes clips', async () => {
    const pub = async () => (await app.inject('/api/libraries')).json() as LibrariesResponse;
    expect((await pub()).libraries[0]!.clipCount).toBe(2);

    const r = await call('PATCH', '/api/admin/clips/clip-1', {
      title: 'New title',
      tags: ['Funny', 'funny'],
      enabled: false,
      attribution: { author: 'A', source: 'S', license: 'CC0' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().clip).toMatchObject({ title: 'New title', tags: ['funny'], enabled: false });
    expect((await pub()).libraries[0]!.clipCount).toBe(1);
    expect((await call('PATCH', '/api/admin/clips/clip-1', { title: '' })).statusCode).toBe(400);
    expect((await call('PATCH', '/api/admin/clips/nope', { title: 'x' })).statusCode).toBe(404);
    // Built-in clips are only disabled, never deleted.
    expect((await call('DELETE', '/api/admin/clips/clip-1')).statusCode).toBe(409);
    await call('PATCH', '/api/admin/clips/clip-1', { enabled: true });

    const lib = (await call('POST', '/api/admin/libraries', { name: 'Uploads' })).json().library;
    const up = fakeUpload(clips, lib.id, 'Mine');
    const listed = await call('GET', `/api/admin/libraries/${lib.id}/clips`);
    expect(listed.json().clips).toEqual([
      expect.objectContaining({ id: up.id, status: 'ready', playable: true, builtin: false }),
    ]);
    const file = await app.inject({ url: up.url!, headers: { range: 'bytes=0-9' } });
    expect(file.statusCode).toBe(206);
    expect((await call('DELETE', `/api/admin/clips/${up.id}`)).statusCode).toBe(204);
    expect((await app.inject(up.url!)).statusCode).toBe(404);
  });
});

describe('clip URLs', async () => {
  const { app } = await adminApp();
  afterAll(() => app.close());

  it('v1 URLs of the built-in library still work, as do library URLs', async () => {
    const old = await app.inject({ url: '/clips/clip-0.mp4', headers: { range: 'bytes=0-99' } });
    expect(old.statusCode).toBe(206);
    expect(old.headers['cache-control']).toMatch(/max-age=3600/);
    expect((await app.inject('/clips/classics/clip-0.mp4')).statusCode).toBe(200);
    expect((await app.inject('/clips/classics/manifest.json')).statusCode).toBe(404);
    expect((await app.inject('/clips/other/clip-0.mp4')).statusCode).toBe(404);
  });
});

describe.skipIf(!hasFfmpeg())('upload + normalize (ffmpeg)', async () => {
  const { app } = await adminApp();
  afterAll(() => app.close());
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

  it('normalizes an upload in the background and serves it', async () => {
    const lib = (
      await app.inject({
        method: 'POST',
        url: '/api/admin/libraries',
        headers: ADMIN,
        payload: { name: 'Mine' },
      })
    ).json().library;
    const r = await app.inject({
      method: 'POST',
      url: `/api/admin/libraries/${lib.id}/clips?title=Test%20clip&ss=1&t=2&tags=a,b&license=CC0`,
      headers: { ...ADMIN, 'content-type': 'application/octet-stream' },
      payload: fs.readFileSync(input),
    });
    expect(r.statusCode).toBe(202);
    const id = r.json().clip.id as string;
    expect(r.json().clip.status).toBe('processing');

    let clip: AdminClip | undefined;
    for (let i = 0; i < 200; i++) {
      const list = await app.inject({
        url: `/api/admin/libraries/${lib.id}/clips`,
        headers: ADMIN,
      });
      clip = (list.json().clips as AdminClip[]).find((c) => c.id === id);
      if (clip?.status !== 'processing') break;
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(clip).toMatchObject({ status: 'ready', width: 320, height: 240, tags: ['a', 'b'] });
    expect(Math.abs(clip!.durationMs - 2000)).toBeLessThan(250);
    expect(clip!.posterUrl).toMatch(/\.jpg$/);
    const file = await app.inject({ url: clip!.url!, headers: { range: 'bytes=0-15' } });
    expect(file.statusCode).toBe(206);
    expect(file.rawPayload.subarray(4, 8).toString()).toBe('ftyp');
    const pub = (await app.inject('/api/libraries')).json() as LibrariesResponse;
    expect(pub.libraries.find((l) => l.id === lib.id)?.clipCount).toBe(1);
  }, 60_000);

  it('rejects files that are not video, and bad trims', async () => {
    const url = `/api/admin/libraries/classics/clips?title=x`;
    const headers = { ...ADMIN, 'content-type': 'application/octet-stream' };
    const junk = await app.inject({ method: 'POST', url, headers, payload: Buffer.alloc(5000, 1) });
    expect(junk.statusCode).toBe(400);
    const late = await app.inject({
      method: 'POST',
      url: `${url}&ss=30`,
      headers,
      payload: fs.readFileSync(input),
    });
    expect(late.statusCode).toBe(400);
    expect(late.json().message).toMatch(/past the end/);
    const long = await app.inject({ method: 'POST', url: `${url}&t=61`, headers, payload: 'x' });
    expect(long.statusCode).toBe(400);
  });
});

describe('room library selection', () => {
  it('plays the library the host picked; refuses unknown ones', () => {
    const lib = ClipLibrary.load(makeClipsDir(2));
    const libraryDir = tmpDir('vj-lib-');
    const withUploads = new ClipLibrary(lib.db, { clipsDir: lib.dir, libraryDir });
    withUploads.reload();
    const other = withUploads.createLibrary({ name: 'Other' });
    const up = fakeUpload(withUploads, other.id, 'Only one', ['solo']);

    const room = new Room({
      code: 'ABCDEF',
      clock: { now: () => Date.now() },
      scheduler: realScheduler,
      emit: () => {},
      clips: [],
      library: withUploads,
      timings: { ...TIMINGS_PRESETS.fast },
      options: { allowSolo: true, allowShortDubbing: true, maxPlayers: 8, limits: LIMITS },
    });
    const j = room.join('Host');
    if ('code' in j) throw new Error(j.message);
    room.connect(j.playerId);
    const snap = () => room.snapshotFor(j.playerId)!;
    expect(snap().settings.libraryId).toBe('classics');
    expect(snap().clipCount).toBe(2);

    const set = (settings: object) => room.handle(j.playerId, { t: 'updateSettings', settings });
    expect(set({ libraryId: 'nope' })).toMatchObject({ code: 'INVALID' });
    expect(set({ mode: 'extended', rounds: 1, dubbingSeconds: 60, tags: ['even'] })).toBeNull();
    expect(set({ libraryId: other.id })).toBeNull();
    // The other library's tags apply; carried-over unknown tags are dropped.
    expect(snap().settings).toMatchObject({ libraryId: other.id, tags: [] });
    expect(snap().availableTags).toEqual(['solo']);
    expect(snap().clipCount).toBe(1);
    // Normal mode keeps the picked library.
    expect(set({ mode: 'normal' })).toBeNull();
    expect(snap().settings.libraryId).toBe(other.id);
    expect(set({ mode: 'extended', rounds: 1, dubbingSeconds: 60, tags: [] })).toBeNull();

    room.handle(j.playerId, { t: 'micStatus', ok: true });
    room.handle(j.playerId, { t: 'setReady', ready: true });
    expect(room.handle(j.playerId, { t: 'startGame' })).toBeNull();
    expect(snap().you.clip?.id).toBe(up.id);
    expect(snap().you.clip?.url).toBe(`/clips/${other.id}/${up.id}.mp4`);
    expect(snap().you.clip).not.toHaveProperty('file');
    room.dispose();
  });
});
