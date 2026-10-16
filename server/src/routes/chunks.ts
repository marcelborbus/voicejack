import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AUDIO_MIMES,
  ChunkIdSchema,
  PLAYER_TOKEN_HEADER,
  PLAYER_TOKEN_QUERY,
  ROOM_CODE_REGEX,
  routes,
  type AudioMime,
  type ChunkUploadResponse,
  LIMITS,
  type ErrorCode,
} from '@dub/shared';
import { sendError, type AppDeps } from '../http/app.js';
import type { Room } from '../room/Room.js';
import { RATE_LIMITS } from '../security/rateLimit.js';

const SUB_ID = /^[A-Za-z0-9_-]{1,64}$/;

const STATUS: Partial<Record<ErrorCode, number>> = {
  BAD_TOKEN: 401,
  ROOM_NOT_FOUND: 404,
  BAD_PHASE: 409,
  LIMIT: 413,
  INVALID: 400,
};

function fail(reply: FastifyReply, code: ErrorCode, message: string, status = STATUS[code] ?? 400) {
  return reply.status(status).send(sendError(code, message));
}

/** `audio/webm; codecs=opus` → `audio/webm;codecs=opus` if it is one of the accepted mimes. */
export function normalizeMime(header: string | undefined): AudioMime | null {
  if (!header) return null;
  const m = header.toLowerCase().replace(/\s+/g, '').replace(/"/g, '');
  return (AUDIO_MIMES as readonly string[]).includes(m) ? (m as AudioMime) : null;
}

function headerToken(req: FastifyRequest): string | undefined {
  const h = req.headers[PLAYER_TOKEN_HEADER.toLowerCase()];
  return Array.isArray(h) ? h[0] : h;
}

interface UploadCtx {
  room: Room;
  playerId: string;
  round: number;
  submissionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    dubUpload?: UploadCtx;
  }
}

type UploadParams = { code: string; round: string; chunkId: string };
type ChunkParams = { code: string; round: string; subId: string; chunkId: string };

export function register(app: FastifyInstance, deps: AppDeps): void {
  const { rooms, store } = deps;
  if (!rooms || !store) return;

  // Raw audio bodies (mime parameters are checked in the handler).
  app.addContentTypeParser(
    /^audio\/(webm|ogg|mp4)/,
    { parseAs: 'buffer', bodyLimit: LIMITS.maxChunkBytes },
    (_req, body, done) => done(null, body),
  );

  /** Resolves room + token + round before the body is read. */
  function auth(
    req: FastifyRequest<{ Params: { code: string; round: string } }>,
    reply: FastifyReply,
    token: string | undefined,
  ): { room: Room; playerId: string; round: number } | null {
    const code = req.params.code.toUpperCase();
    const room = ROOM_CODE_REGEX.test(code) ? rooms!.get(code) : undefined;
    if (!room) {
      void fail(reply, 'ROOM_NOT_FOUND', 'no such room');
      return null;
    }
    const playerId = token ? room.authenticate(token) : null;
    if (!playerId) {
      void fail(reply, 'BAD_TOKEN', 'missing or unknown token');
      return null;
    }
    const round = Number(req.params.round);
    if (!Number.isInteger(round) || round < 0) {
      void fail(reply, 'INVALID', 'bad round');
      return null;
    }
    return { room, playerId, round };
  }

  app.post<{ Params: UploadParams; Body: Buffer }>(
    routes.chunkUpload,
    {
      config: { rateLimit: RATE_LIMITS.chunkUpload },
      onRequest: async (req, reply) => {
        const a = auth(req, reply, headerToken(req));
        if (!a) return reply;
        if (!ChunkIdSchema.safeParse(req.params.chunkId).success)
          return fail(reply, 'INVALID', 'bad chunk id');
        if (!normalizeMime(req.headers['content-type'])) {
          return fail(
            reply,
            'INVALID',
            `Content-Type must be one of ${AUDIO_MIMES.join(', ')}`,
            415,
          );
        }
        const t = a.room.uploadTarget(a.playerId, a.round);
        if ('code' in t) return fail(reply, t.code, t.message);
        req.dubUpload = { ...a, submissionId: t.submissionId };
      },
    },
    async (req, reply) => {
      const ctx = req.dubUpload!;
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) return fail(reply, 'INVALID', 'empty body');
      // Re-check: the phase may have ended while the body streamed in.
      const t = ctx.room.uploadTarget(ctx.playerId, ctx.round);
      if ('code' in t) return fail(reply, t.code, t.message);
      const r = await store.put(
        ctx.room.code,
        ctx.round,
        ctx.submissionId,
        req.params.chunkId,
        normalizeMime(req.headers['content-type'])!,
        body,
      );
      if (!r.ok) return fail(reply, r.code, r.message);
      ctx.room.notify(ctx.playerId);
      const res: ChunkUploadResponse = { id: req.params.chunkId, bytes: r.bytes };
      return reply.status(201).send(res);
    },
  );

  app.get<{ Params: ChunkParams; Querystring: Record<string, string | undefined> }>(
    routes.chunk,
    { config: { rateLimit: RATE_LIMITS.chunkDownload } },
    async (req, reply) => {
      const a = auth(req, reply, headerToken(req) ?? req.query[PLAYER_TOKEN_QUERY]);
      if (!a) return reply;
      const { subId, chunkId } = req.params;
      if (!SUB_ID.test(subId) || !ChunkIdSchema.safeParse(chunkId).success) {
        return fail(reply, 'INVALID', 'bad id', 404);
      }
      const e = a.room.canDownload(a.playerId, a.round, subId);
      if (e)
        return fail(
          reply,
          e.code,
          e.message,
          e.code === 'BAD_PHASE' ? 403 : e.code === 'INVALID' ? 404 : undefined,
        );
      const c = store.get(a.room.code, subId, chunkId);
      if (!c || c.round !== a.round) return fail(reply, 'INVALID', 'no such chunk', 404);
      return reply
        .header('Content-Type', c.mime)
        .header('Content-Length', String(c.bytes))
        .header('Cache-Control', 'private, no-cache')
        .send(store.open(c));
    },
  );
}
