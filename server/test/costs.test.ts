import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/http/app.js';
import { ClipLibrary } from '../src/clips/ClipLibrary.js';
import { makeClipsDir, testConfig, tmpDir } from './helpers.js';

// V11: GET /costs.json (owner file first, then the built client copy).
describe('GET /costs.json', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  function clientDist(costs?: unknown): string {
    const dir = tmpDir('dub-client-');
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
    if (costs !== undefined) fs.writeFileSync(path.join(dir, 'costs.json'), JSON.stringify(costs));
    return dir;
  }
  async function start(over: Parameters<typeof testConfig>[0]) {
    app = await buildApp({ config: testConfig(over), clips: ClipLibrary.load(makeClipsDir(1)) });
    return app;
  }

  it('serves the built copy when no owner file is configured', async () => {
    const a = await start({ clientDist: clientDist({ monthlyEur: 5, players: 100 }) });
    const res = await a.inject({ method: 'GET', url: '/costs.json' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ monthlyEur: 5, players: 100 });
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('prefers COSTS_PATH and picks up edits without a restart', async () => {
    const owner = path.join(tmpDir('dub-costs-'), 'costs.json');
    fs.writeFileSync(owner, JSON.stringify({ monthlyEur: 7, players: 150 }));
    const a = await start({
      clientDist: clientDist({ monthlyEur: 5, players: 100 }),
      costsPath: owner,
    });
    expect((await a.inject({ method: 'GET', url: '/costs.json' })).json()).toEqual({
      monthlyEur: 7,
      players: 150,
    });
    fs.writeFileSync(owner, JSON.stringify({ monthlyEur: 9, players: 200 }));
    expect((await a.inject({ method: 'GET', url: '/costs.json' })).json().monthlyEur).toBe(9);
  });

  it('falls back to the built copy when the owner file is missing or broken', async () => {
    const owner = path.join(tmpDir('dub-costs-'), 'costs.json');
    const a = await start({
      clientDist: clientDist({ monthlyEur: 5, players: 100 }),
      costsPath: owner,
    });
    expect((await a.inject({ method: 'GET', url: '/costs.json' })).json().monthlyEur).toBe(5);
    fs.writeFileSync(owner, '{ nope');
    expect((await a.inject({ method: 'GET', url: '/costs.json' })).json().monthlyEur).toBe(5);
  });

  it('404s when there is no copy at all', async () => {
    const a = await start({});
    expect((await a.inject({ method: 'GET', url: '/costs.json' })).statusCode).toBe(404);
  });
});
