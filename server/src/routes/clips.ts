import type { FastifyInstance, FastifyReply } from 'fastify';
import { libraryRoutes, routes, type LibrariesResponse } from '@dub/shared';
import { sendError, type AppDeps } from '../http/app.js';

const SEND_OPTS = { acceptRanges: true, cacheControl: true, maxAge: 3600 * 1000 } as const;

/**
 * Clip files, Range supported, cached for an hour:
 * - `GET /clips/:file` — built-in clips (CLIPS_DIR, the v1 URLs, kept for the official library),
 * - `GET /clips/:libraryId/:file` — any library (uploads in LIBRARY_DIR/<libraryId>/).
 * Only files of known clips are served.
 * `GET /api/libraries` — official libraries for the lobby picker.
 */
export function register(app: FastifyInstance, deps: AppDeps): void {
  const send = (reply: FastifyReply, libraryId: string | null, file: string) => {
    const dir = deps.clips.serveDir(libraryId, file);
    if (!dir) return reply.status(404).send(sendError('INVALID', 'unknown clip'));
    return reply.sendFile(file, dir, SEND_OPTS);
  };

  app.get<{ Params: { file: string } }>(routes.clip, (req, reply) =>
    send(reply, null, req.params.file),
  );
  app.get<{ Params: { libraryId: string; file: string } }>(
    libraryRoutes.libraryClip,
    (req, reply) => send(reply, req.params.libraryId, req.params.file),
  );

  app.get(
    libraryRoutes.libraries,
    { config: { rateLimit: { max: 120, timeWindow: 60_000 } } },
    async (_req, reply): Promise<LibrariesResponse> => {
      reply.header('Cache-Control', 'no-cache');
      return { libraries: deps.clips.summaries() };
    },
  );
}
