import fs from 'node:fs';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import {
  ADMIN_UPLOAD_MAX_BYTES,
  CreateLibraryBodySchema,
  UpdateClipBodySchema,
  UpdateLibraryBodySchema,
  UploadClipQuerySchema,
  libraryRoutes,
  type AdminClipsResponse,
  type AdminLibrariesResponse,
  type AdminMeResponse,
  type ClipAttribution,
  type UploadClipResponse,
} from '@dub/shared';
import { sendError, type AppDeps } from '../http/app.js';
import { LibraryError } from '../clips/ClipLibrary.js';
import { JobQueue, hasFfmpeg, normalize, probe, resolveTrim } from '../clips/normalize.js';
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

function libraryFail(reply: FastifyReply, e: unknown) {
  if (e instanceof LibraryError) {
    const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'CONFLICT' ? 409 : 400;
    return reply.status(status).send(sendError('INVALID', e.message));
  }
  throw e;
}

function bad(reply: FastifyReply, message: string) {
  return reply.status(400).send(sendError('INVALID', message));
}

/** Byte counter that errors once more than `max` bytes went through. */
function limit(max: number): Transform {
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > max) cb(Object.assign(new Error('upload too large'), { statusCode: 413 }));
      else cb(null, chunk);
    },
  });
}

/** `/api/admin/*` (V05): libraries + clip CRUD and uploads, admins only. */
export function register(app: FastifyInstance, deps: AppDeps): void {
  const { config, clips } = deps;
  const trusted = compileTrust(config.trustProxy);
  const dev = config.adminDev;
  const jobs = new JobQueue(5);
  let ffmpeg: boolean | null = null;

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
    const passThrough = (
      _req: FastifyRequest,
      payload: Readable,
      done: (e: null, b: Readable) => void,
    ) => done(null, payload);
    admin.addContentTypeParser('application/octet-stream', passThrough);
    admin.addContentTypeParser(/^video\//, passThrough);

    admin.get(libraryRoutes.adminMe, async (req): Promise<AdminMeResponse> => req.admin!);

    admin.get(libraryRoutes.adminLibraries, async (): Promise<AdminLibrariesResponse> => ({
      libraries: clips.adminLibraries(),
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
        if (!(req.body && typeof (req.body as Readable).pipe === 'function')) {
          return bad(reply, 'send the video as the raw body (application/octet-stream)');
        }
        const len = Number(req.headers['content-length'] ?? 0);
        if (len > ADMIN_UPLOAD_MAX_BYTES) {
          return reply.status(413).send(sendError('LIMIT', 'upload is larger than 200 MB'));
        }
        let dir: string;
        try {
          dir = clips.uploadDir(req.params.id);
        } catch (e) {
          return libraryFail(reply, e);
        }
        ffmpeg ??= hasFfmpeg();
        if (!ffmpeg) return reply.status(503).send(sendError('INVALID', 'ffmpeg is not installed'));
        if (jobs.size >= jobs.maxPending) {
          return reply.status(503).send(sendError('RATE_LIMITED', 'busy, try again in a minute'));
        }

        const tmpDir = path.join(clips.libraryDir!, '.tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        const tmp = path.join(tmpDir, `${nanoid(16)}.upload`);
        let queued = false;
        try {
          try {
            await pipeline(
              req.body as Readable,
              limit(ADMIN_UPLOAD_MAX_BYTES),
              fs.createWriteStream(tmp),
            );
          } catch (e) {
            if ((e as { statusCode?: number }).statusCode === 413) {
              return reply.status(413).send(sendError('LIMIT', 'upload is larger than 200 MB'));
            }
            throw e;
          }
          let input;
          let trim;
          try {
            input = await probe(tmp);
            trim = resolveTrim(input, { ss: q.data.ss, t: q.data.t });
          } catch (e) {
            return bad(reply, (e as Error).message);
          }
          const attribution: ClipAttribution = {
            author: q.data.author.trim(),
            source: q.data.source.trim(),
            license: q.data.license.trim(),
          };
          if (q.data.licenseUrl?.trim()) attribution.licenseUrl = q.data.licenseUrl.trim();
          const tags = [
            ...new Set(
              q.data.tags
                .split(',')
                .map((t) => t.trim().toLowerCase())
                .filter((t) => t && t.length <= 32),
            ),
          ].slice(0, 32);
          const up = clips.createUpload(req.params.id, {
            title: q.data.title,
            tags,
            attribution,
          });
          const job = jobs.push(async () => {
            try {
              const res = await normalize({
                input: tmp,
                probe: input,
                trim,
                outFile: path.join(dir, up.file),
                posterFile: path.join(dir, up.poster),
              });
              clips.finishUpload(up.id, res);
              req.log.info({ clip: up.id, ...res }, 'admin: clip normalized');
            } catch (e) {
              req.log.warn({ clip: up.id, err: (e as Error).message }, 'admin: normalize failed');
              clips.failUpload(up.id, (e as Error).message);
            } finally {
              fs.rmSync(tmp, { force: true });
            }
          });
          if (!job) {
            clips.failUpload(up.id, 'queue full');
            return reply.status(503).send(sendError('RATE_LIMITED', 'busy, try again later'));
          }
          queued = true;
          void job.catch(() => {});
          const res: UploadClipResponse = { clip: clips.adminClip(up.id) };
          return reply.status(202).send(res);
        } finally {
          if (!queued) fs.rmSync(tmp, { force: true });
        }
      },
    );
  });
}
