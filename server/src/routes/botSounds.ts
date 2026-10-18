import type { FastifyInstance } from 'fastify';
import { routes } from '@dub/shared';
import { sendError, type AppDeps } from '../http/app.js';

const KEY = /^[0-9a-f]{24}\.webm$/;

/**
 * v1.2 #47 `GET /api/bot-sounds/:key`: one snippet of the bot sound pool, for `botVoice`.
 *
 * Deliberately open (no room token): it serves nothing but the snippets currently in the
 * in-memory pool, which are cut from the official libraries' clips (themselves public under
 * `/clips/*`), the dev pool or synthetic tones. Never a path on disk: the key is a content hash
 * looked up in the pool, so nothing private (uploads, private libraries) is reachable. Keys are
 * content-addressed, so responses are immutable.
 */
export function register(app: FastifyInstance, deps: AppDeps): void {
  const { rooms } = deps;
  if (!rooms) return;
  app.get<{ Params: { key: string } }>(
    routes.botSound,
    { config: { rateLimit: { max: 600, timeWindow: 60_000 } } },
    async (req, reply) => {
      const key = req.params.key;
      const sound = KEY.test(key) ? rooms.botSound(key) : undefined;
      if (!sound) {
        reply.header('Cache-Control', 'no-store');
        return reply.status(404).send(sendError('INVALID', 'unknown sound'));
      }
      reply.header('Cache-Control', 'public, max-age=86400, immutable');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.type('audio/webm');
      return reply.send(sound.data);
    },
  );
}
