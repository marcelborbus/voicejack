import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { LEGAL_ROUTE, type LegalResponse } from '@dub/shared';
import { buildApp } from '../src/http/app.js';
import { ClipLibrary } from '../src/clips/ClipLibrary.js';
import { LEGAL_PAGES } from '../src/routes/legal.js';
import { makeClipsDir, testConfig, tmpDir } from './helpers.js';

const LEGAL = {
  name: 'Erika Mustermann',
  address: 'Musterstraße 1\n12345 Musterstadt',
  email: 'legal@example.org',
};

// V12: GET /api/legal from LEGAL_PATH, and the legal SPA routes.
describe('GET /api/legal', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });
  async function start(over: Parameters<typeof testConfig>[0]) {
    app = await buildApp({ config: testConfig(over), clips: ClipLibrary.load(makeClipsDir(1)) });
    return app;
  }
  async function get(a: FastifyInstance): Promise<LegalResponse> {
    const res = await a.inject({ method: 'GET', url: LEGAL_ROUTE });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    return res.json();
  }

  it('serves the file when present, and picks up edits without a restart', async () => {
    const file = path.join(tmpDir('dub-legal-'), 'legal.json');
    fs.writeFileSync(file, JSON.stringify({ ...LEGAL, vatId: 'DE123456789' }));
    const a = await start({ legalPath: file });
    expect(await get(a)).toEqual({ configured: true, legal: { ...LEGAL, vatId: 'DE123456789' } });
    fs.writeFileSync(file, JSON.stringify({ ...LEGAL, phone: '+49 1' }));
    expect(await get(a)).toEqual({ configured: true, legal: { ...LEGAL, phone: '+49 1' } });
  });

  it('says "not configured" when the file is missing', async () => {
    const a = await start({ legalPath: path.join(tmpDir('dub-legal-'), 'nope.json') });
    expect(await get(a)).toEqual({ configured: false });
  });

  it('says "not configured" for broken or incomplete files', async () => {
    const file = path.join(tmpDir('dub-legal-'), 'legal.json');
    const a = await start({ legalPath: file });
    fs.writeFileSync(file, '{ not json');
    expect(await get(a)).toEqual({ configured: false });
    fs.writeFileSync(file, JSON.stringify({ name: 'X', email: 'not-an-email', address: 'Y' }));
    expect(await get(a)).toEqual({ configured: false });
    fs.writeFileSync(file, JSON.stringify({ name: 'X', email: 'x@example.org' }));
    expect(await get(a)).toEqual({ configured: false });
  });

  it('the committed example is valid', async () => {
    const example = path.resolve(import.meta.dirname, '../../deploy/legal.example.json');
    const a = await start({ legalPath: example });
    const r = await get(a);
    expect(r.configured).toBe(true);
  });

  it('serves the SPA for the legal pages', async () => {
    const dist = tmpDir('dub-client-');
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>spa</title>');
    const a = await start({ clientDist: dist });
    for (const page of LEGAL_PAGES) {
      const res = await a.inject({ method: 'GET', url: page });
      expect(res.statusCode, page).toBe(200);
      expect(res.body).toContain('<title>spa</title>');
    }
  });

  it('404s the legal pages without a client build', async () => {
    const a = await start({});
    expect((await a.inject({ method: 'GET', url: '/impressum' })).statusCode).toBe(404);
  });
});
