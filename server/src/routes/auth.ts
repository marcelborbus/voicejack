import type { FastifyInstance } from 'fastify';
import { AuthRequestBodySchema, routes } from '@dub/shared';
import { sendError, type AppDeps } from '../http/app.js';
import { SESSION_TTL_MS } from '../accounts/Accounts.js';
import { readCookie, SESSION_COOKIE, sessionCookie } from '../accounts/cookies.js';
import { GuestLimiter, type GuestLimits } from '../accounts/GuestLimiter.js';
import { createMailer } from '../mail/Mailer.js';
import { confirmPage, invalidLinkPage, loginMail } from '../mail/templates.js';
import { toMe } from './me.js';

/** Magic-link requests per client IP per hour (plus a global brake for the goneo relay). */
export const AUTH_IP_LIMITS: GuestLimits = { perIp: 10, global: 300, windowMs: 3600_000 };
/** Magic-link requests per email address per window. */
export const AUTH_EMAIL_LIMIT = { max: 3, windowMs: 15 * 60_000 };

// Strict for the server-rendered confirm page: no scripts, nothing remote, token not leaked.
const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

/**
 * V04 magic-link auth: POST /api/auth/request, GET+POST /api/auth/verify, POST /api/auth/logout.
 * Registered in an encapsulated scope so the urlencoded body parser (confirm form) stays local.
 */
export async function register(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const accounts = deps.accounts;
  if (!accounts) return;
  const secure = deps.config.cookieSecure;
  const mailer = deps.mailer ?? createMailer(deps.config, (m) => app.log.info(m));
  const ipLimiter = deps.authLimiter ?? new GuestLimiter(AUTH_IP_LIMITS);
  const verifyUrl = `${deps.config.publicUrl}${routes.authVerify}`;

  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 1024 },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );

    scope.post(
      routes.authRequest,
      { config: { rateLimit: { max: 20, timeWindow: 60_000 } } },
      async (req, reply) => {
        // JSON only: a cross-site <form> can't send it, so no login CSRF via the urlencoded parser.
        if (!req.headers['content-type']?.startsWith('application/json')) {
          return reply.status(415).send(sendError('INVALID', 'expected application/json'));
        }
        const parsed = AuthRequestBodySchema.safeParse(req.body);
        if (!parsed.success) return reply.status(400).send(sendError('INVALID', 'invalid email'));
        const { email } = parsed.data;
        if (!ipLimiter.take(req.ip)) {
          return reply.status(429).send(sendError('RATE_LIMITED', 'too many sign-in requests'));
        }
        if (accounts.loginTokensSince(email, AUTH_EMAIL_LIMIT.windowMs) >= AUTH_EMAIL_LIMIT.max) {
          return reply
            .status(429)
            .send(sendError('RATE_LIMITED', 'too many links for this address, try again later'));
        }
        const current = accounts.session(readCookie(req.headers.cookie, SESSION_COOKIE));
        const token = accounts.createLoginToken(email, current?.user.id ?? null);
        const link = `${verifyUrl}?t=${encodeURIComponent(token)}`;
        // Not awaited: same latency for every address; Postfix queues and retries anyway.
        mailer
          .send({ from: deps.config.mailFrom, to: email, ...loginMail(link) })
          .catch((e: unknown) => req.log.error({ err: e }, 'login mail failed'));
        // Same answer whether or not an account exists.
        return reply.status(202).send({ ok: true });
      },
    );

    scope.get<{ Querystring: { t?: string } }>(
      routes.authVerify,
      { config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
      async (req, reply) => {
        const t = typeof req.query.t === 'string' ? req.query.t : '';
        const email = accounts.peekLoginToken(t);
        reply.headers(PAGE_HEADERS);
        if (!email) return reply.status(410).send(invalidLinkPage());
        return reply.send(confirmPage(t, email, routes.authVerify));
      },
    );

    scope.post<{ Body: { t?: unknown } | undefined }>(
      routes.authVerify,
      { config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
      async (req, reply) => {
        const t = typeof req.body?.t === 'string' ? req.body.t : '';
        const res = accounts.consumeLoginToken(t);
        reply.header('Cache-Control', 'no-store');
        if (!res) return reply.redirect('/?login=invalid', 303);
        // Rotate: the browser's previous session ends, a fresh one is issued.
        accounts.deleteSession(readCookie(req.headers.cookie, SESSION_COOKIE));
        const fresh = accounts.createSession(res.user.id);
        reply.header('Set-Cookie', sessionCookie(fresh.token, SESSION_TTL_MS, secure));
        req.log.info({ userId: res.user.id, merged: res.merged }, 'login');
        return reply.redirect('/?login=ok', 303);
      },
    );

    scope.post(
      routes.authLogout,
      { config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
      async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        accounts.deleteSession(readCookie(req.headers.cookie, SESSION_COOKIE));
        const guest = accounts.createGuest();
        const fresh = accounts.createSession(guest.id);
        reply.header('Set-Cookie', sessionCookie(fresh.token, SESSION_TTL_MS, secure));
        return toMe(guest);
      },
    );
  });
}
