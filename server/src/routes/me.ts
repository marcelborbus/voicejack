import type { FastifyInstance } from 'fastify';
import { routes, type MeResponse } from '@dub/shared';
import { sendError, type AppDeps } from '../http/app.js';
import { SESSION_TTL_MS, type User } from '../accounts/Accounts.js';
import { readCookie, SESSION_COOKIE, sessionCookie } from '../accounts/cookies.js';
import { GuestLimiter } from '../accounts/GuestLimiter.js';

function toMe(u: User): MeResponse {
  return {
    user: {
      id: u.id,
      kind: u.kind,
      displayName: u.displayName || null,
      elo: u.elo,
      publicGamesPlayed: u.publicGamesPlayed,
    },
  };
}

/** GET /api/me: current user; lazily creates a guest + session cookie on first visit. */
export function register(app: FastifyInstance, deps: AppDeps): void {
  const accounts = deps.accounts;
  if (!accounts) return;
  const limiter = deps.guestLimiter ?? new GuestLimiter();
  const secure = deps.config.cookieSecure;

  app.get(
    routes.me,
    { config: { rateLimit: { max: 120, timeWindow: 60_000 } } },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const token = readCookie(req.headers.cookie, SESSION_COOKIE);
      const s = accounts.session(token);
      if (s && token) {
        accounts.touch(s.user);
        const extended = accounts.refreshSession(token, s);
        if (extended !== null) {
          reply.header('Set-Cookie', sessionCookie(token, SESSION_TTL_MS, secure));
        }
        return toMe(s.user);
      }
      if (!limiter.take(req.ip)) {
        return reply.status(429).send(sendError('RATE_LIMITED', 'too many new guests, try later'));
      }
      const user = accounts.createGuest();
      const fresh = accounts.createSession(user.id);
      reply.header('Set-Cookie', sessionCookie(fresh.token, SESSION_TTL_MS, secure));
      return toMe(user);
    },
  );
}
