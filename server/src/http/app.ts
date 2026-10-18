import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import {
  WS_MAX_MESSAGE_BYTES,
  routes,
  type ApiError,
  type ErrorCode,
  type HealthResponse,
} from '@dub/shared';
import type { Config } from '../config.js';
import type { ClipLibrary } from '../clips/ClipLibrary.js';
import type { RoomManager } from '../room/RoomManager.js';
import type { ChunkStore } from '../uploads/ChunkStore.js';
import type { Accounts } from '../accounts/Accounts.js';
import type { GuestLimiter } from '../accounts/GuestLimiter.js';
import type { Mailer } from '../mail/Mailer.js';
import * as clipsRoutes from '../routes/clips.js';
import * as adminRoutes from '../routes/admin.js';
import * as myLibrariesRoutes from '../routes/myLibraries.js';
import * as roomsRoutes from '../routes/rooms.js';
import * as chunksRoutes from '../routes/chunks.js';
import * as meRoutes from '../routes/me.js';
import * as authRoutes from '../routes/auth.js';
import * as gateway from '../ws/gateway.js';
import * as presenceGateway from '../ws/presenceGateway.js';
import * as statsRoutes from '../routes/stats.js';
import type { Presence } from '../presence/Presence.js';
import type { Friends } from '../friends/Friends.js';
import * as friendsRoutes from '../routes/friends.js';
import * as costsRoutes from '../routes/costs.js';
import * as legalRoutes from '../routes/legal.js';
import type { Matchmaker } from '../match/Matchmaker.js';

/** Global request body limit (largest chunk is 2 MiB). */
export const BODY_LIMIT = Math.floor(2.5 * 1024 * 1024);

export interface AppDeps {
  config: Config;
  clips: ClipLibrary;
  rooms?: RoomManager;
  store?: ChunkStore;
  /** Users + sessions (SQLite). Without it /api/me is absent and rooms never link users. */
  accounts?: Accounts;
  guestLimiter?: GuestLimiter;
  /** V04 magic-link mail (default from config: SMTP or the log transport). */
  mailer?: Mailer;
  /** V04 per-IP limiter for POST /api/auth/request (default AUTH_IP_LIMITS). */
  authLimiter?: GuestLimiter;
  /** Online/in-game counts + `/ws/presence` (V07). Without it the presence socket is absent. */
  presence?: Presence;
  /** V10 friends, DMs, invites (`/api/friends/*`). Needs `accounts`. */
  friends?: Friends;
  /** V08 public matchmaking over `/ws/presence` (queueJoin / queueLeave). */
  matchmaker?: Matchmaker;
  /** Epoch ms the process started (health uptime). */
  startedAt?: number;
}

/** Every route module exports `register(app, deps)`. */
export type RegisterFn = (app: FastifyInstance, deps: AppDeps) => void | Promise<void>;

export function sendError(code: ErrorCode, message: string): ApiError {
  return { error: code, message };
}

export async function buildApp(
  deps: AppDeps,
  opts: { logger?: boolean | { level: string } } = {},
): Promise<FastifyInstance> {
  const { config } = deps;
  const startedAt = deps.startedAt ?? Date.now();
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: config.trustProxy,
    bodyLimit: BODY_LIMIT,
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    let code: ErrorCode = 'INVALID';
    if (status === 429) code = 'RATE_LIMITED';
    else if (status === 413) code = 'LIMIT';
    if (status >= 500) req.log.error(err);
    reply.status(status).send(sendError(code, status >= 500 ? 'internal error' : err.message));
  });

  await app.register(fastifyRateLimit, {
    global: false,
    errorResponseBuilder: (_req, ctx) => ({
      statusCode: ctx.statusCode,
      error: 'RATE_LIMITED',
      message: `rate limited, retry in ${ctx.after}`,
    }),
  });
  await app.register(fastifyWebsocket, { options: { maxPayload: WS_MAX_MESSAGE_BYTES } });

  const hasClient = fs.existsSync(path.join(config.clientDist, 'index.html'));
  await app.register(fastifyStatic, {
    root: hasClient ? config.clientDist : deps.clips.dir,
    serve: hasClient,
    prefix: '/',
    wildcard: true,
    index: ['index.html'],
  });

  app.get(routes.health, async (): Promise<HealthResponse> => {
    const s = deps.rooms?.stats() ?? { rooms: 0, players: 0 };
    return { ok: true, ...s, uptimeS: Math.round((Date.now() - startedAt) / 1000) };
  });

  const modules: RegisterFn[] = [
    clipsRoutes.register,
    adminRoutes.register,
    myLibrariesRoutes.register,
    roomsRoutes.register,
    chunksRoutes.register,
    meRoutes.register,
    authRoutes.register,
    gateway.register,
    presenceGateway.register,
    statsRoutes.register,
    friendsRoutes.register,
    costsRoutes.register,
    legalRoutes.register,
  ];
  for (const register of modules) await register(app, deps);

  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split('?')[0]!;
    if (
      hasClient &&
      req.method === 'GET' &&
      (url === '/' || url.startsWith('/r/') || /^\/(admin|library)(\/|$)/.test(url))
    ) {
      return reply.type('text/html').sendFile('index.html', config.clientDist);
    }
    return reply.status(404).send(sendError('INVALID', 'not found'));
  });

  return app;
}
