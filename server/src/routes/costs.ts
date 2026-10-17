import fs from 'node:fs';
import path from 'node:path';
import type { RegisterFn } from '../http/app.js';
import { sendError } from '../http/app.js';

/**
 * V11 support prompt numbers. `GET /costs.json` serves the owner-edited `COSTS_PATH` when it
 * exists (no rebuild, no restart: read per request), else the copy built from
 * `client/public/costs.json`. The body is passed through as-is; the client validates it.
 */
export const register: RegisterFn = (app, { config }) => {
  app.get('/costs.json', async (_req, reply) => {
    reply.header('Cache-Control', 'no-cache');
    if (config.costsPath) {
      try {
        const body = await fs.promises.readFile(config.costsPath, 'utf8');
        JSON.parse(body); // a typo in the owner's file must not break the page: fall back
        return reply.type('application/json').send(body);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          app.log.warn(`costs: ignoring ${config.costsPath}: ${(e as Error).message}`);
        }
      }
    }
    if (fs.existsSync(path.join(config.clientDist, 'costs.json'))) {
      return reply.sendFile('costs.json', config.clientDist, { cacheControl: false });
    }
    return reply.status(404).send(sendError('INVALID', 'not found'));
  });
};
