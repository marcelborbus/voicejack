import type { FastifyInstance } from 'fastify';
import { STATS_PATH, type StatsResponse } from '@dub/shared';
import type { AppDeps } from '../http/app.js';
import { RATE_LIMITS } from '../security/rateLimit.js';

/** `GET /api/stats` (V07): live counts for monitoring and as a presence-socket fallback. */
export function register(app: FastifyInstance, deps: AppDeps): void {
  app.get(
    STATS_PATH,
    { config: { rateLimit: RATE_LIMITS.roomInfo } },
    async (): Promise<StatsResponse> => {
      const rooms = deps.rooms?.size ?? 0;
      if (deps.presence) {
        const { online, inGame } = deps.presence.counts();
        return { online, inGame, rooms };
      }
      // No presence service: fall back to room sockets only.
      let online = 0;
      let inGame = 0;
      const ids = new Set<string>();
      for (const c of deps.rooms?.humanConnections() ?? []) {
        if (c.userId) ids.add(c.userId);
        else online++;
        if (c.phase !== 'LOBBY') inGame++;
      }
      return { online: online + ids.size, inGame, rooms };
    },
  );
}
