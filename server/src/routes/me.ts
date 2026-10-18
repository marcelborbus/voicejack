import type { FastifyInstance } from 'fastify';
import { routes, UpdateMeBodySchema, type MeResponse } from '@dub/shared';
import { sendError, type AppDeps } from '../http/app.js';
import { SESSION_TTL_MS, type User } from '../accounts/Accounts.js';
import { readCookie, SESSION_COOKIE, sessionCookie } from '../accounts/cookies.js';
import { GUEST_LIMITS, GuestLimiter } from '../accounts/GuestLimiter.js';

export function toMe(u: User): MeResponse {
  return {
    user: {
      id: u.id,
      kind: u.kind,
      displayName: u.displayName || null,
      email: u.kind === 'registered' ? u.email : null,
      elo: u.elo,
      publicGamesPlayed: u.publicGamesPlayed,
    },
  };
}

/**
 * GET /api/me: current user; lazily creates a guest + session cookie on first visit.
 * PATCH /api/me {displayName}: rename (V04). DELETE /api/me: delete the account (V04).
 */
export function register(app: FastifyInstance, deps: AppDeps): void {
  const accounts = deps.accounts;
  if (!accounts) return;
  const limiter =
    deps.guestLimiter ??
    new GuestLimiter(
      deps.config.guestLimitPerIp
        ? { ...GUEST_LIMITS, perIp: deps.config.guestLimitPerIp }
        : undefined,
    );
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

  app.patch(
    routes.me,
    { config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const s = accounts.session(readCookie(req.headers.cookie, SESSION_COOKIE));
      if (!s) return reply.status(401).send(sendError('BAD_TOKEN', 'no session'));
      const parsed = UpdateMeBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send(sendError('INVALID', 'name: 1–20 chars'));
      accounts.setDisplayName(s.user.id, parsed.data.displayName);
      return toMe(accounts.getUser(s.user.id)!);
    },
  );

  // Anonymizes the account and ends all its sessions, then hands this browser a fresh guest.
  app.delete(
    routes.me,
    { config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const s = accounts.session(readCookie(req.headers.cookie, SESSION_COOKIE));
      if (!s) return reply.status(401).send(sendError('BAD_TOKEN', 'no session'));
      // V06: the user's private clip libraries go with the account (files included).
      deps.clips.deleteUserLibraries(s.user.id);
      accounts.deleteAccount(s.user.id);
      req.log.info({ userId: s.user.id }, 'account deleted');
      const user = accounts.createGuest();
      const fresh = accounts.createSession(user.id);
      reply.header('Set-Cookie', sessionCookie(fresh.token, SESSION_TTL_MS, secure));
      return toMe(user);
    },
  );
}
