import type { FastifyInstance } from 'fastify';
import {
  NAME_MAX_LENGTH,
  TEST_ROOM_PATH,
  TestRoomBodySchema,
  type TestRoomResponse,
} from '@dub/shared';
import { sendError, type AppDeps } from '../http/app.js';
import { readCookie, SESSION_COOKIE } from '../accounts/cookies.js';
import { compileTrust } from '../security/trustedProxy.js';
import { originAllowed } from '../ws/gateway.js';
import { adminIdentity } from './admin.js';

/**
 * v1.2 #46 `POST /api/admin/test-room` {bots, libraryId?, rounds, dubbingSeconds, name?,
 * autoStart?}: a private room with the admin as host and 1–7 bots, for testing in prod without
 * DEV_BOTS (#53: by default it starts by itself once the host is in).
 * Same gate as the rest of `/api/admin` (Authelia `Remote-Groups: admins` from a trusted proxy,
 * `ADMIN_DEV` on loopback) plus the Origin check. Returns the host's reconnect token.
 */
export function register(app: FastifyInstance, deps: AppDeps): void {
  const { rooms, clips, config, accounts } = deps;
  if (!rooms) return;
  const trusted = compileTrust(config.trustProxy);

  void app.register(async (scope) => {
    scope.addHook('onRequest', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!adminIdentity(req, { trusted, dev: config.adminDev })) {
        return reply.status(403).send(sendError('INVALID', 'admins only'));
      }
      if (!originAllowed(req)) return reply.status(403).send(sendError('INVALID', 'bad origin'));
    });

    scope.post(
      TEST_ROOM_PATH,
      { config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
      async (req, reply) => {
        const body = TestRoomBodySchema.safeParse(req.body ?? {});
        if (!body.success) return reply.status(400).send(sendError('INVALID', 'invalid settings'));
        const b = body.data;
        if (b.libraryId !== undefined && clips.access(b.libraryId)?.visibility !== 'official') {
          return reply.status(400).send(sendError('INVALID', 'pick an official library'));
        }
        const session = accounts?.session(readCookie(req.headers.cookie, SESSION_COOKIE));
        const name = (b.name ?? session?.user.displayName ?? '').slice(0, NAME_MAX_LENGTH);
        const made = rooms.createTestRoom({
          name: name || 'Admin',
          userId: session?.user.id ?? null,
          bots: b.bots,
          autoStart: b.autoStart,
          settings: {
            rounds: b.rounds,
            dubbingSeconds: b.dubbingSeconds,
            ...(b.libraryId ? { libraryId: b.libraryId } : {}),
          },
        });
        if (!('room' in made)) {
          const status = made.code === 'ROOM_FULL' ? 503 : 400;
          return reply.status(status).send(sendError(made.code, made.message));
        }
        req.log.info({ bots: b.bots }, 'admin test room created');
        // #53: never wait for the bot sound pool (it loads at startup; a cold pool plays the
        // fallback tones until the snippets are cut).
        const res: TestRoomResponse = {
          code: made.room.code,
          token: made.join.token,
          botSounds: rooms.botSoundCount,
        };
        return reply.status(201).send(res);
      },
    );
  });
}
