import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { libraryRoutes, routes, type LibrariesResponse } from '@dub/shared';
import { sendError, type AppDeps } from '../http/app.js';
import { hostLibraries } from '../clips/HostLibraries.js';

const SEND_OPTS = { acceptRanges: true, cacheControl: true, maxAge: 3600 * 1000 } as const;

/**
 * Clip files, Range supported, cached for an hour:
 * - `GET /clips/:file` — built-in clips (CLIPS_DIR, the v1 URLs, kept for the official library),
 * - `GET /clips/:libraryId/:file` — any library (uploads in LIBRARY_DIR/<libraryId>/).
 * Only files of known clips are served.
 *
 * V06 private libraries: the file name is random per clip (not the clip id), and the request's
 * `vj_session` cookie (sent automatically by `<video src>`, same origin) must belong to the
 * library's owner or to a player of a live room that has this library selected. Everyone else
 * gets the same 404 as for an unknown file. Responses are `Cache-Control: private`.
 *
 * `GET /api/libraries` — official libraries plus the caller's own private ones (lobby picker).
 */
export function register(app: FastifyInstance, deps: AppDeps): void {
  const host = hostLibraries(deps.clips);
  const userOf = (req: FastifyRequest) =>
    deps.accounts?.userIdFromCookie(req.headers.cookie) ?? null;

  const send = (
    req: FastifyRequest,
    reply: FastifyReply,
    libraryId: string | null,
    file: string,
  ) => {
    const dir = deps.clips.serveDir(libraryId, file);
    const notFound = () => reply.status(404).send(sendError('INVALID', 'unknown clip'));
    if (!dir) return notFound();
    if (libraryId !== null && deps.clips.access(libraryId)?.visibility === 'private') {
      if (!host.canView(libraryId, userOf(req), deps.rooms)) return notFound();
      reply.header('Cache-Control', 'private, max-age=3600');
      return reply.sendFile(file, dir, { acceptRanges: true, cacheControl: false });
    }
    return reply.sendFile(file, dir, SEND_OPTS);
  };

  app.get<{ Params: { file: string } }>(routes.clip, (req, reply) =>
    send(req, reply, null, req.params.file),
  );
  app.get<{ Params: { libraryId: string; file: string } }>(
    libraryRoutes.libraryClip,
    (req, reply) => send(req, reply, req.params.libraryId, req.params.file),
  );

  app.get(
    libraryRoutes.libraries,
    { config: { rateLimit: { max: 120, timeWindow: 60_000 } } },
    async (req, reply): Promise<LibrariesResponse> => {
      reply.header('Cache-Control', 'private, no-cache');
      return { libraries: deps.clips.summaries(userOf(req)) };
    },
  );
}
