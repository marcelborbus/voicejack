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
// V13 anti-scraping: the address goes out in two parts.
const { email: _email, ...LEGAL_REST } = LEGAL;
const WIRE = { ...LEGAL_REST, emailUser: 'legal', emailDomain: 'example.org' };

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
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(res.body).not.toContain('@');
    return res.json();
  }

  it('serves the file when present, and picks up edits without a restart', async () => {
    const file = path.join(tmpDir('dub-legal-'), 'legal.json');
    fs.writeFileSync(file, JSON.stringify({ ...LEGAL, vatId: 'DE123456789' }));
    const a = await start({ legalPath: file });
    expect(await get(a)).toEqual({ configured: true, legal: { ...WIRE, vatId: 'DE123456789' } });
    fs.writeFileSync(file, JSON.stringify({ ...LEGAL, phone: '+49 1' }));
    expect(await get(a)).toEqual({ configured: true, legal: { ...WIRE, phone: '+49 1' } });
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
    fs.writeFileSync(
      path.join(dist, 'index.html'),
      '<!doctype html><html><head><title>spa</title></head></html>',
    );
    const a = await start({ clientDist: dist });
    for (const page of LEGAL_PAGES) {
      const res = await a.inject({ method: 'GET', url: page });
      expect(res.statusCode, page).toBe(200);
      expect(res.body).toContain('<title>spa</title>');
      expect(res.body).toContain('<meta name="robots" content="noindex" />');
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    }
    // Other pages stay indexable.
    const home = await a.inject({ method: 'GET', url: '/' });
    expect(home.body).not.toContain('name="robots"');
  });

  it('404s the legal pages without a client build', async () => {
    const a = await start({});
    expect((await a.inject({ method: 'GET', url: '/impressum' })).statusCode).toBe(404);
  });
});

describe('robots.txt (V13)', () => {
  it('disallows /api/ and /impressum', () => {
    const txt = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../client/public/robots.txt'),
      'utf8',
    );
    expect(txt).toMatch(/^User-agent: \*$/m);
    expect(txt).toMatch(/^Disallow: \/api\/$/m);
    expect(txt).toMatch(/^Disallow: \/impressum$/m);
  });
});
