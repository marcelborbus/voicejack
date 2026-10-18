import type { FastifyInstance } from 'fastify';
import { LAST_GAME_PATH, ROOM_CODE_REGEX, type LastGameResponse } from '@dub/shared';
import { sendError, type AppDeps } from '../http/app.js';
import { readCookie, SESSION_COOKIE } from '../accounts/cookies.js';

/**
 * V09 `GET /api/me/last-game?room=CODE`: the caller's rating change from the latest public
 * game in that room (Final shows "1012 → 1031 (+19)"). `{game: null}` for private rooms or
 * players without an account. Recorded before the FINAL snapshot is sent, so it is ready.
 */
export function register(app: FastifyInstance, deps: AppDeps): void {
  const { accounts, ratings } = deps;
  if (!accounts || !ratings) return;
  app.get<{ Querystring: { room?: string } }>(
    LAST_GAME_PATH,
    { config: { rateLimit: { max: 60, timeWindow: 60_000 } } },
    async (req, reply): Promise<LastGameResponse | undefined> => {
      reply.header('Cache-Control', 'no-store');
      const room = String(req.query.room ?? '').toUpperCase();
      if (!ROOM_CODE_REGEX.test(room)) {
        return reply.status(400).send(sendError('INVALID', 'room: a room code'));
      }
      const s = accounts.session(readCookie(req.headers.cookie, SESSION_COOKIE));
      if (!s) return reply.status(401).send(sendError('BAD_TOKEN', 'no session'));
      return { game: ratings.lastGame(s.user.id, room) };
    },
  );
}
