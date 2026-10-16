import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ClipLibrary, toClipInfo } from '../src/clips/ClipLibrary.js';
import { buildApp } from '../src/http/app.js';
import { loadConfig } from '../src/config.js';
import { makeClipsDir, testConfig, tmpDir } from './helpers.js';

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'a',
  title: 'A',
  file: 'a.mp4',
  durationMs: 5000,
  width: 640,
  height: 360,
  attribution: { author: 'x', source: 'y', license: 'CC-BY' },
  ...over,
});

describe('ClipLibrary', () => {
  it('loads valid clips and maps urls', () => {
    const dir = makeClipsDir(2);
    const lib = ClipLibrary.load(dir);
    expect(lib.size).toBe(2);
    expect(lib.get('clip-0')?.url).toBe('/clips/clip-0.mp4');
    expect(lib.tags()).toEqual(['even', 'odd']);
    expect(toClipInfo(lib.get('clip-0')!)).not.toHaveProperty('file');
  });

  it('skips clips whose file is missing', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'a.mp4'), 'x');
    const lib = ClipLibrary.fromManifest(dir, {
      clips: [entry(), entry({ id: 'b', file: 'b.mp4' })],
    });
    expect(lib.clips.map((c) => c.id)).toEqual(['a']);
    expect(lib.warnings[0]).toMatch(/b\.mp4 missing/);
  });

  it.each([
    ['duplicate ids', { clips: [entry(), entry()] }],
    ['path traversal', { clips: [entry({ file: '../etc/passwd' })] }],
    ['over 60 s', { clips: [entry({ durationMs: 61_000 })] }],
    ['missing attribution', { clips: [entry({ attribution: undefined })] }],
    ['not an object', []],
  ])('rejects invalid manifest: %s', (_name, json) => {
    expect(() => ClipLibrary.fromManifest(tmpDir(), json)).toThrow(/invalid clip manifest/);
  });

  it('empty library when there is no manifest', () => {
    const lib = ClipLibrary.load(tmpDir());
    expect(lib.size).toBe(0);
    expect(lib.warnings).toHaveLength(1);
  });
});

describe('config', () => {
  it('parses env', () => {
    const c = loadConfig({
      PORT: '4000',
      TIMINGS: 'fast',
      ALLOW_SOLO: '1',
      ICE_SERVERS: '[{"urls":"stun:x"}]',
    });
    expect(c.port).toBe(4000);
    expect(c.timings.uploadGraceMs).toBe(500);
    expect(c.allowSolo).toBe(true);
    expect(c.allowShortDubbing).toBe(true);
    expect(c.iceServers).toEqual([{ urls: 'stun:x' }]);
  });
  it('defaults to prod timings and google stun', () => {
    const c = loadConfig({});
    expect(c.timings.uploadGraceMs).toBe(3000);
    expect(c.allowShortDubbing).toBe(false);
    expect(c.iceServers[0]!.urls).toContain('stun:');
  });
  it('rejects bad ICE_SERVERS', () => {
    expect(() => loadConfig({ ICE_SERVERS: '{"urls":1}' })).toThrow();
  });
});

describe('HTTP app', async () => {
  const clipsDir = makeClipsDir(2);
  const clips = ClipLibrary.load(clipsDir);
  const app = await buildApp({ config: testConfig({ clipsDir }), clips });
  afterAll(() => app.close());

  it('health', async () => {
    const r = await app.inject('/api/health');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, rooms: 0, players: 0 });
  });

  it('serves a clip with Range → 206', async () => {
    const r = await app.inject({ url: '/clips/clip-1.mp4', headers: { range: 'bytes=0-99' } });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 0-99/4096');
    expect(r.rawPayload.length).toBe(100);
    expect(r.headers['content-type']).toMatch(/video\/mp4/);
    expect(r.headers['cache-control']).toMatch(/max-age=3600/);
  });

  it('full clip → 200', async () => {
    const r = await app.inject('/clips/clip-0.mp4');
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.length).toBe(4096);
  });

  it('unlisted files are not served', async () => {
    expect((await app.inject('/clips/manifest.json')).statusCode).toBe(404);
    expect((await app.inject('/clips/..%2Fmanifest.json')).statusCode).toBe(404);
  });

  it('unknown api path → 404 json', async () => {
    const r = await app.inject('/api/nope');
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: 'INVALID' });
  });
});

describe('SPA fallback', async () => {
  const clientDist = tmpDir();
  fs.writeFileSync(path.join(clientDist, 'index.html'), '<!doctype html><title>dub</title>');
  fs.writeFileSync(path.join(clientDist, 'app.js'), 'console.log(1)');
  const app = await buildApp({
    config: testConfig({ clientDist, clipsDir: makeClipsDir(1) }),
    clips: ClipLibrary.load(makeClipsDir(1)),
  });
  afterAll(() => app.close());

  it('serves index for / and /r/*, assets directly', async () => {
    expect((await app.inject('/')).body).toContain('<title>dub</title>');
    expect((await app.inject('/r/ABCDEF')).body).toContain('<title>dub</title>');
    expect((await app.inject('/app.js')).body).toContain('console.log');
    expect((await app.inject('/missing.js')).statusCode).toBe(404);
  });
});
