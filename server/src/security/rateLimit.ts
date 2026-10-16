import type { FastifyRequest } from 'fastify';
import { PLAYER_TOKEN_HEADER } from '@dub/shared';

/** Per-route REST limits (PLAN §3). Use as `config: { rateLimit: RATE_LIMITS.createRoom }`. */
export const RATE_LIMITS = {
  createRoom: { max: 5, timeWindow: 60_000 },
  roomInfo: { max: 60, timeWindow: 60_000 },
  chunkUpload: {
    max: 120,
    timeWindow: 60_000,
    keyGenerator: (req: FastifyRequest) => tokenKey(req),
  },
  chunkDownload: { max: 600, timeWindow: 60_000 },
} as const;

function tokenKey(req: FastifyRequest): string {
  const h = req.headers[PLAYER_TOKEN_HEADER.toLowerCase()];
  const token = Array.isArray(h) ? h[0] : h;
  return token ? `t:${token}` : `ip:${req.ip}`;
}

/**
 * Token bucket for per-socket WS message limits (60 msg/s, burst 120). `now` is injected so
 * tests can drive it.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
    now: number = Date.now(),
  ) {
    this.tokens = burst;
    this.last = now;
  }

  /** Takes one token; false when the bucket is empty. */
  take(now: number = Date.now()): boolean {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSec);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export const WS_RATE = { perSec: 60, burst: 120 } as const;
