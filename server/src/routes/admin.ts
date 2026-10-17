import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ADMIN_UPLOAD_MAX_BYTES,
  CreateLibraryBodySchema,
  SetDisabledBodySchema,
  UpdateClipBodySchema,
  UpdateLibraryBodySchema,
  UploadBanBodySchema,
  UploadClipQuerySchema,
  libraryRoutes,
  type AdminClipsResponse,
  type AdminLibrariesResponse,
  type AdminMeResponse,
  type AdminUserLibrariesResponse,
} from '@dub/shared';
import { sendError, type AppDeps } from '../http/app.js';
import { hostLibraries } from '../clips/HostLibraries.js';
import { acceptRawVideo, bad, handleUpload, libraryFail } from '../clips/upload.js';
import { compileTrust } from '../security/trustedProxy.js';
import { originAllowed } from '../ws/gateway.js';

/** Authelia group whose members may use /api/admin (PLAN-v1.1 "Admin"). */
export const ADMIN_GROUP = 'admins';

export interface AdminIdentity {
  user: string;
  groups: string[];
  dev: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminIdentity;
  }
}

function header(req: FastifyRequest, name: string): string {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? '';
}

/**
 * Who is calling, or null. nginx runs Authelia's auth_request on /admin and /api/admin/ and sets
 * `Remote-User` / `Remote-Groups` (snippets/authelia-authrequest.conf); those headers are only
 * believed when the TCP peer is a trusted proxy (TRUST_PROXY), since anyone reaching the port
 * directly could send them. ADMIN_DEV=1 (never with NODE_ENV=production) lets loopback in.
 */
export function adminIdentity(
  req: FastifyRequest,
  opts: { trusted: (peer: string | undefined) => boolean; dev: boolean },
): AdminIdentity | null {
  const peer = req.socket.remoteAddress;
  if (opts.dev && compileTrust('loopback')(peer)) {
    return { user: header(req, 'remote-user') || 'dev', groups: [ADMIN_GROUP], dev: true };
  }
  if (!opts.trusted(peer)) return null;
  const user = header(req, 'remote-user');
  const groups = header(req, 'remote-groups')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
  if (!user || !groups.includes(ADMIN_GROUP)) return null;
  return { user, groups, dev: false };
}

/** `/api/admin/*` (V05): libraries + clip CRUD and uploads, admins only. */
export function register(app: FastifyInstance, deps: AppDeps): void {
  const { config, clips } = deps;
  const trusted = compileTrust(config.trustProxy);
  const dev = config.adminDev;
  const host = hostLibraries(clips);

  void app.register(async (admin) => {
    admin.addHook('onRequest', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const who = adminIdentity(req, { trusted, dev });
      if (!who) return reply.status(403).send(sendError('INVALID', 'admins only'));
      if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req)) {
        return reply.status(403).send(sendError('INVALID', 'bad origin'));
      }
      req.admin = who;
    });
    // Uploads are streamed to disk, never buffered.
    acceptRawVideo(admin);

    admin.get(libraryRoutes.adminMe, async (req): Promise<AdminMeResponse> => req.admin!);

    // Official libraries; private ones are under /api/admin/user-libraries (V06).
    admin.get(libraryRoutes.adminLibraries, async (): Promise<AdminLibrariesResponse> => ({
      libraries: clips.adminLibraries({ visibility: 'official' }),
    }));

    admin.post(libraryRoutes.adminLibraries, async (req, reply) => {
      const body = CreateLibraryBodySchema.safeParse(req.body);
      if (!body.success) return bad(reply, 'name: 1–60 characters');
      return reply.status(201).send({ library: clips.createLibrary(body.data) });
    });

    admin.patch<{ Params: { id: string } }>(libraryRoutes.adminLibrary, async (req, reply) => {
      const body = UpdateLibraryBodySchema.safeParse(req.body);
      if (!body.success) return bad(reply, 'invalid library');
      try {
        return { library: clips.updateLibrary(req.params.id, body.data) };
      } catch (e) {
        return libraryFail(reply, e);
      }
    });

    admin.delete<{ Params: { id: string } }>(libraryRoutes.adminLibrary, async (req, reply) => {
      try {
        clips.deleteLibrary(req.params.id);
        return reply.status(204).send();
      } catch (e) {
        return libraryFail(reply, e);
      }
    });

    admin.post<{ Params: { id: string } }>(
      libraryRoutes.adminLibraryDefault,
      async (req, reply) => {
        try {
          return { library: clips.setDefault(req.params.id) };
        } catch (e) {
          return libraryFail(reply, e);
        }
      },
    );

    admin.get<{ Params: { id: string } }>(
      libraryRoutes.adminLibraryClips,
      async (req, reply): Promise<AdminClipsResponse | FastifyReply> => {
        try {
          return { clips: clips.adminClips(req.params.id) };
        } catch (e) {
          return libraryFail(reply, e);
        }
      },
    );

    admin.patch<{ Params: { id: string } }>(libraryRoutes.adminClip, async (req, reply) => {
      const body = UpdateClipBodySchema.safeParse(req.body);
      if (!body.success) return bad(reply, `invalid clip: ${body.error.issues[0]?.message ?? ''}`);
      try {
        return { clip: clips.updateClip(req.params.id, body.data) };
      } catch (e) {
        return libraryFail(reply, e);
      }
    });

    admin.delete<{ Params: { id: string } }>(libraryRoutes.adminClip, async (req, reply) => {
      try {
        clips.deleteClip(req.params.id);
        return reply.status(204).send();
      } catch (e) {
        return libraryFail(reply, e);
      }
    });

    admin.post<{ Params: { id: string }; Querystring: Record<string, string> }>(
      libraryRoutes.adminLibraryClips,
      { bodyLimit: ADMIN_UPLOAD_MAX_BYTES + 1024 * 1024 },
      async (req, reply) => {
        const q = UploadClipQuerySchema.safeParse(req.query);
        if (!q.success) {
          const i = q.error.issues[0];
          return bad(reply, `invalid ${i?.path.join('.') || 'query'}: ${i?.message ?? ''}`);
        }
        return handleUpload(req, reply, {
          clips,
          libraryId: req.params.id,
          query: q.data,
          maxBytes: ADMIN_UPLOAD_MAX_BYTES,
          job: { priority: 'admin' },
          logTag: 'admin',
        });
      },
    );

    // ---------------------------------------------------------- V06 moderation

    admin.get(libraryRoutes.adminUserLibraries, async (): Promise<AdminUserLibrariesResponse> => ({
      libraries: host.adminOverview(),
      reports: host.clipReports(),
    }));

    // Private clips are only served to owners / room members on /clips; admins preview here.
    admin.get<{ Params: { id: string; kind: string } }>(
      libraryRoutes.adminClipFile,
      async (req, reply) => {
        const c = clips.clipMeta(req.params.id);
        const file = req.params.kind === 'poster' ? c?.poster : c?.file;
        if (
          !c ||
          !c.dir ||
          !file ||
          (req.params.kind !== 'poster' && req.params.kind !== 'video')
        ) {
          return reply.status(404).send(sendError('INVALID', 'unknown clip'));
        }
        return reply.sendFile(file, c.dir, { acceptRanges: true, cacheControl: false });
      },
    );

    admin.post<{ Params: { id: string } }>(
      libraryRoutes.adminLibraryDisabled,
      async (req, reply) => {
        const body = SetDisabledBodySchema.safeParse(req.body);
        if (!body.success) return bad(reply, 'disabled: boolean');
        try {
          const library = clips.setLibraryDisabled(req.params.id, body.data.disabled);
          req.log.info(
            { library: library.id, disabled: library.disabled, by: req.admin!.user },
            'admin: library disabled',
          );
          return { library };
        } catch (e) {
          return libraryFail(reply, e);
        }
      },
    );

    admin.post<{ Params: { id: string } }>(libraryRoutes.adminUploadBan, async (req, reply) => {
      const body = UploadBanBodySchema.safeParse(req.body);
      if (!body.success) return bad(reply, 'banned: boolean');
      if (!host.setUploadBanned(req.params.id, body.data.banned)) {
        return reply.status(404).send(sendError('INVALID', 'unknown user'));
      }
      req.log.info(
        { userId: req.params.id, banned: body.data.banned, by: req.admin!.user },
        'admin: upload ban',
      );
      return { userId: req.params.id, uploadBanned: body.data.banned };
    });

    admin.post<{ Params: { id: string } }>(libraryRoutes.adminReportResolve, async (req, reply) => {
      if (!host.resolveReport(Number(req.params.id))) {
        return reply.status(404).send(sendError('INVALID', 'unknown or resolved report'));
      }
      return reply.status(204).send();
    });
  });
}
