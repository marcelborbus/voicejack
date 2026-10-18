import fs from 'node:fs';
import path from 'node:path';
import { LEGAL_ROUTE, type LegalResponse } from '@dub/shared';
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
      const r = await readLegal(config.legalPath);
      if (!r.ok) {
        req.log.warn(`legal: Impressum not configured: ${r.reason}`);
        return { configured: false };
      }
      return { configured: true, legal: r.legal };
    },
  );

  // SPA entry points (the not-found fallback only knows /, /r/*, /admin, /library).
  const index = path.join(config.clientDist, 'index.html');
  for (const page of LEGAL_PAGES) {
    app.get(page, async (_req, reply) => {
      if (!fs.existsSync(index)) return reply.callNotFound();
      return reply.type('text/html').sendFile('index.html', config.clientDist);
    });
  }
};
