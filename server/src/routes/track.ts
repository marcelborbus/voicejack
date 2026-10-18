import type { FastifyInstance } from 'fastify';
import { CLIENT_EVENTS, TRACK_PATH, TrackBodySchema } from '@dub/shared';
import { sendError, type AppDeps } from '../http/app.js';
import { uaInfo } from '../analytics/Analytics.js';

/** Per-IP (in memory only, never stored): page views + errors + feedback. */
export const TRACK_RATE_LIMIT = { max: 60, timeWindow: 60_000 } as const;

/**
 * `POST /api/t` (V15): the only client-side analytics endpoint. Allow-listed events only
 * (page_view, client_error, feedback); unknown events are ignored with 204. The User-Agent is
 * reduced to browser family + device class here and then discarded; the IP is only used by the
 * in-memory rate limiter. No cookie is read or set.
 */
export function register(app: FastifyInstance, deps: AppDeps): void {
  const analytics = deps.analytics;
  if (!analytics) return;

  app.post(
    TRACK_PATH,
    { config: { rateLimit: TRACK_RATE_LIMIT }, bodyLimit: 4096 },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const e = (req.body as { e?: unknown } | null)?.e;
      if (typeof e !== 'string' || !(CLIENT_EVENTS as readonly string[]).includes(e)) {
        return reply.status(204).send();
      }
      const body = TrackBodySchema.safeParse(req.body);
      if (!body.success) return reply.status(400).send(sendError('INVALID', 'invalid event'));
      const ev = body.data;
      switch (ev.e) {
        case 'page_view': {
          const { browser, device } = uaInfo(req.headers['user-agent']);
          if (device !== 'bot') analytics.track('page_view', { route: ev.route, browser, device });
          break;
        }
        case 'client_error':
          analytics.track(
            'client_error',
            { hash: ev.hash, where: ev.where, route: ev.route },
            ev.n,
          );
          break;
        case 'feedback':
          analytics.addFeedback({
            kind: ev.kind,
            mood: ev.mood,
            comment: ev.comment,
            context: ev.context,
          });
          break;
      }
      return reply.status(204).send();
    },
  );
}
