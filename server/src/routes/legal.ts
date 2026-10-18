import fs from 'node:fs';
import path from 'node:path';
import { LEGAL_ROUTE, toLegalPublic, type LegalResponse } from '@dub/shared';
import type { RegisterFn } from '../http/app.js';
import { readLegal } from '../legal/legal.js';

/** Client routes of the legal pages (V12); linked from the footer on every page. */
export const LEGAL_PAGES = ['/impressum', '/datenschutz', '/takedown'] as const;

export const register: RegisterFn = (app, { config }) => {
  app.get(
    LEGAL_ROUTE,
    { config: { rateLimit: { max: 60, timeWindow: 60_000 } } },
    async (req, reply): Promise<LegalResponse> => {
      reply.header('Cache-Control', 'no-cache');
      reply.header('X-Robots-Tag', 'noindex, nofollow');
      const r = await readLegal(config.legalPath);
      if (!r.ok) {
        req.log.warn(`legal: Impressum not configured: ${r.reason}`);
        return { configured: false };
      }
      return { configured: true, legal: toLegalPublic(r.legal) };
    },
  );

  // SPA entry points (the not-found fallback only knows /, /r/*, /admin, /library), with
  // `noindex` in the HTML and the header (V13, anti-scraping), so search engines skip them.
  const index = path.join(config.clientDist, 'index.html');
  for (const page of LEGAL_PAGES) {
    app.get(page, async (_req, reply) => {
      let html: string;
      try {
        html = await fs.promises.readFile(index, 'utf8');
      } catch {
        return reply.callNotFound();
      }
      reply.header('X-Robots-Tag', 'noindex, nofollow');
      reply.header('Cache-Control', 'no-cache');
      return reply.type('text/html').send(withNoindex(html));
    });
  }
};

export const NOINDEX_META = '<meta name="robots" content="noindex" />';

/** Adds the robots meta right after `<head>` (idempotent). */
export function withNoindex(html: string): string {
  if (html.includes('name="robots"')) return html;
  return html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${NOINDEX_META}`);
}
