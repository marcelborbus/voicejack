import type { FastifyInstance } from 'fastify';
import { routes } from '@dub/shared';
import { sendError, type AppDeps } from '../http/app.js';

/** `GET /clips/:file`: only manifest-listed files, Range supported, cached for an hour. */
export function register(app: FastifyInstance, deps: AppDeps): void {
  app.get<{ Params: { file: string } }>(routes.clip, (req, reply) => {
    const { file } = req.params;
    if (!deps.clips.hasFile(file)) {
      return reply.status(404).send(sendError('INVALID', 'unknown clip'));
    }
    return reply.sendFile(file, deps.clips.dir, {
      acceptRanges: true,
      cacheControl: true,
      maxAge: 3600 * 1000,
    });
  });
}
