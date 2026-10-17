import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CreateLibraryBodySchema,
  ReportClipBodySchema,
  UpdateLibraryBodySchema,
  UpdateMyClipBodySchema,
  UploadMyClipQuerySchema,
  USER_MAX_LIBRARIES,
  USER_UPLOAD_MAX_BYTES,
  libraryRoutes,
  type MyClipsResponse,
  type MyLibrariesResponse,
} from '@dub/shared';
import { sendError, type AppDeps } from '../http/app.js';
import type { User } from '../accounts/Accounts.js';
import { readCookie, SESSION_COOKIE } from '../accounts/cookies.js';
import { hostLibraries } from '../clips/HostLibraries.js';
import { acceptRawVideo, bad, handleUpload, libraryFail } from '../clips/upload.js';
import { originAllowed } from '../ws/gateway.js';

declare module 'fastify' {
  interface FastifyRequest {
    vjUser?: User;
  }
}

/**
 * V06 host libraries, registered users only (`vj_session` of a `kind='registered'` user):
 * - `/api/my/libraries` GET (own libraries + quota) / POST (create, ≤ 5),
 * - `/api/my/libraries/:id` PATCH / DELETE, `/api/my/libraries/:id/clips` GET / POST (upload),
 * - `/api/my/clips/:id` PATCH / DELETE (own clips only).
 * Uploads go through the admin pipeline (ffprobe, trim, ≤ 60 s) on the shared queue, after the
 * admin jobs, one job per user at a time, ≤ 30 clips / 300 MB / 10 uploads a day per user.
 *
 * `POST /api/clips/:id/report` — any player (guest too) of a live room that has the clip's
 * private library selected reports it to the admin.
 */
export function register(app: FastifyInstance, deps: AppDeps): void {
  const { clips, accounts } = deps;
  if (!accounts) return;
  const host = hostLibraries(clips);

  const ownLibrary = (req: FastifyRequest, reply: FastifyReply, id: string) => {
    const a = clips.access(id);
    if (!a || a.visibility !== 'private' || a.ownerUserId !== req.vjUser!.id) {
      void reply.status(404).send(sendError('INVALID', 'unknown library'));
      return null;
    }
    return a;
  };
  const ownClip = (req: FastifyRequest, reply: FastifyReply, id: string) => {
    const c = clips.clipMeta(id);
    const a = c && clips.access(c.libraryId);
    if (!c || !a || a.visibility !== 'private' || a.ownerUserId !== req.vjUser!.id) {
      void reply.status(404).send(sendError('INVALID', 'unknown clip'));
      return null;
    }
    return c;
  };

  void app.register(async (my) => {
    my.addHook('onRequest', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req)) {
        return reply.status(403).send(sendError('INVALID', 'bad origin'));
      }
      const s = accounts.session(readCookie(req.headers.cookie, SESSION_COOKIE));
      if (!s) return reply.status(401).send(sendError('BAD_TOKEN', 'no session'));
      if (s.user.kind !== 'registered') {
        return reply.status(403).send(sendError('INVALID', 'sign in to create clip libraries'));
      }
      req.vjUser = s.user;
    });
    acceptRawVideo(my);

    my.get(libraryRoutes.myLibraries, async (req): Promise<MyLibrariesResponse> => ({
      libraries: clips.adminLibraries({ visibility: 'private', ownerUserId: req.vjUser!.id }),
      quota: host.quota(req.vjUser!.id),
    }));

    my.post(
      libraryRoutes.myLibraries,
      { config: { rateLimit: { max: 20, timeWindow: 60_000 } } },
      async (req, reply) => {
        const body = CreateLibraryBodySchema.safeParse(req.body);
        if (!body.success) return bad(reply, 'name: 1–60 characters');
        const userId = req.vjUser!.id;
        if (clips.usage(userId).libraries >= USER_MAX_LIBRARIES) {
          return reply
            .status(403)
            .send(sendError('LIMIT', `at most ${USER_MAX_LIBRARIES} libraries per account`));
        }
        const library = clips.createLibrary(body.data, { userId, visibility: 'private' });
        return reply.status(201).send({ library });
      },
    );

    my.patch<{ Params: { id: string } }>(libraryRoutes.myLibrary, async (req, reply) => {
      if (!ownLibrary(req, reply, req.params.id)) return reply;
      const body = UpdateLibraryBodySchema.safeParse(req.body);
      if (!body.success) return bad(reply, 'invalid library');
      return { library: clips.updateLibrary(req.params.id, body.data) };
    });

    my.delete<{ Params: { id: string } }>(libraryRoutes.myLibrary, async (req, reply) => {
      if (!ownLibrary(req, reply, req.params.id)) return reply;
      try {
        clips.deleteLibrary(req.params.id);
        return reply.status(204).send();
      } catch (e) {
        return libraryFail(reply, e);
      }
    });

    my.get<{ Params: { id: string } }>(
      libraryRoutes.myLibraryClips,
      async (req, reply): Promise<MyClipsResponse | FastifyReply> => {
        if (!ownLibrary(req, reply, req.params.id)) return reply;
        return { clips: clips.adminClips(req.params.id) };
      },
    );

    my.post<{ Params: { id: string }; Querystring: Record<string, string> }>(
      libraryRoutes.myLibraryClips,
      {
        bodyLimit: USER_UPLOAD_MAX_BYTES + 1024 * 1024,
        config: { rateLimit: { max: 20, timeWindow: 60_000 } },
      },
      async (req, reply) => {
        const lib = ownLibrary(req, reply, req.params.id);
        if (!lib) return reply;
        if (lib.disabled) {
          return reply.status(403).send(sendError('INVALID', 'this library was disabled'));
        }
        const q = UploadMyClipQuerySchema.safeParse(req.query);
        if (!q.success) {
          const i = q.error.issues[0];
          return bad(reply, `invalid ${i?.path.join('.') || 'query'}: ${i?.message ?? ''}`);
        }
        const userId = req.vjUser!.id;
        const refused = host.uploadRefusal(userId);
        if (refused) return reply.status(403).send(sendError('LIMIT', refused));
        return handleUpload(req, reply, {
          clips,
          libraryId: req.params.id,
          query: q.data,
          maxBytes: USER_UPLOAD_MAX_BYTES,
          job: { priority: 'user', owner: userId },
          uploadedBy: userId,
          rightsConfirmedAt: Date.now(),
          // Re-checked after the (slow) body: a parallel request may have used the quota.
          admit: () => host.uploadRefusal(userId),
          onQueued: () => host.recordUpload(userId),
          afterNormalize: () => host.storageExceeded(userId),
          logTag: 'my-library',
        });
      },
    );

    my.patch<{ Params: { id: string } }>(libraryRoutes.myClip, async (req, reply) => {
      if (!ownClip(req, reply, req.params.id)) return reply;
      const body = UpdateMyClipBodySchema.safeParse(req.body);
      if (!body.success) return bad(reply, `invalid clip: ${body.error.issues[0]?.message ?? ''}`);
      try {
        return { clip: clips.updateClip(req.params.id, body.data) };
      } catch (e) {
        return libraryFail(reply, e);
      }
    });

    my.delete<{ Params: { id: string } }>(libraryRoutes.myClip, async (req, reply) => {
      if (!ownClip(req, reply, req.params.id)) return reply;
      try {
        clips.deleteClip(req.params.id);
        return reply.status(204).send();
      } catch (e) {
        return libraryFail(reply, e);
      }
    });
  });

  app.post<{ Params: { id: string } }>(
    libraryRoutes.reportClip,
    { config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!originAllowed(req)) return reply.status(403).send(sendError('INVALID', 'bad origin'));
      const s = accounts.session(readCookie(req.headers.cookie, SESSION_COOKIE));
      if (!s) return reply.status(401).send(sendError('BAD_TOKEN', 'no session'));
      const body = ReportClipBodySchema.safeParse(req.body);
      if (!body.success) return bad(reply, 'reason: 1–500 characters');
      const clip = clips.clipMeta(req.params.id);
      const a = clip && clips.access(clip.libraryId);
      const room =
        clip && a?.visibility === 'private'
          ? host.roomOf(clip.libraryId, s.user.id, deps.rooms)
          : null;
      if (!clip || !room) {
        return reply
          .status(404)
          .send(sendError('INVALID', 'only clips of the private library in your room'));
      }
      const id = host.reportClip({
        clipId: clip.id,
        roomCode: room,
        reporterUserId: s.user.id,
        reporterName: s.user.displayName || 'player',
        reason: body.data.reason,
      });
      if (id === null) {
        return reply.status(409).send(sendError('LIMIT', 'you already reported this clip'));
      }
      req.log.info({ report: id, clip: clip.id }, 'clip reported');
      return reply.status(201).send({ id });
    },
  );
}
