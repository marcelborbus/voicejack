import { z } from 'zod';

/**
 * Global presence socket (V07). Every page opens one; the room socket (`/ws`) stays as is.
 * Identity comes from the `vj_session` cookie on the upgrade request, never from a message.
 *
 * Both directions are `t`-discriminated unions so later tasks only add members:
 * - V08 matchmaking: C2S `queueJoin` / `queueLeave`, S2C `queue` / `matchFound`.
 * - V10 friends + DMs: C2S `dm` / `invite` (+ friend requests), S2C `friendStatus` / `dm` / `invite`.
 */
export const PRESENCE_WS_PATH = '/ws/presence';
/** Count pushes are throttled to at most one per this interval. */
export const PRESENCE_THROTTLE_MS = 1000;
/** `GET /api/stats`: counts for monitoring and as a fallback when the socket is down. */
export const STATS_PATH = '/api/stats';

export interface PresenceCounts {
  /** Distinct users (or anonymous sockets) with a presence or room socket. Bots never count. */
  online: number;
  /** Humans connected to rooms whose phase is not LOBBY. */
  inGame: number;
  /** Users in the public matchmaking queue (0 until V08). */
  lookingForGame: number;
}

export interface StatsResponse {
  online: number;
  inGame: number;
  rooms: number;
}

// ---------------------------------------------------------------- client → server
const count = z.number().int().min(0);

export const PresencePingSchema = z.object({ t: z.literal('ping'), c: z.number() });

// TODO(V08): z.object({ t: z.literal('queueJoin') }) — enter the public matchmaking queue.
// TODO(V08): z.object({ t: z.literal('queueLeave') }).
// TODO(V10): z.object({ t: z.literal('dm'), to: UserId, body: z.string().min(1).max(500) }).
// TODO(V10): z.object({ t: z.literal('invite'), to: UserId, code: RoomCodeSchema }).

export const PresenceC2SSchema = z.discriminatedUnion('t', [PresencePingSchema]);
export type PresenceC2S = z.infer<typeof PresenceC2SSchema>;
export type PresenceC2SType = PresenceC2S['t'];
export type PresenceC2SOf<T extends PresenceC2SType> = Extract<PresenceC2S, { t: T }>;

// ---------------------------------------------------------------- server → client
export const PresenceCountsMsgSchema = z.object({
  t: z.literal('counts'),
  online: count,
  inGame: count,
  lookingForGame: count,
});
export const PresencePongSchema = z.object({ t: z.literal('pong'), c: z.number(), s: z.number() });
export const PresenceErrorSchema = z.object({
  t: z.literal('error'),
  code: z.enum(['INVALID', 'RATE_LIMITED']),
  message: z.string(),
});

// TODO(V08): z.object({ t: z.literal('queue'), position: count, size: count, waitedMs: count }).
// TODO(V08): z.object({ t: z.literal('matchFound'), code: RoomCodeSchema }).
// TODO(V10): z.object({ t: z.literal('friendStatus'), userId, status: z.enum(['offline','online','inGame']) }).
// TODO(V10): z.object({ t: z.literal('dm'), from: UserId, body: z.string(), at: z.number() }).
// TODO(V10): z.object({ t: z.literal('invite'), from: UserId, fromName: z.string(), code: RoomCodeSchema }).

export const PresenceS2CSchema = z.discriminatedUnion('t', [
  PresenceCountsMsgSchema,
  PresencePongSchema,
  PresenceErrorSchema,
]);
export type PresenceS2C = z.infer<typeof PresenceS2CSchema>;
export type PresenceS2CType = PresenceS2C['t'];
export type PresenceS2COf<T extends PresenceS2CType> = Extract<PresenceS2C, { t: T }>;

function parseWith<T>(schema: z.ZodType<T>, raw: string): T | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = schema.safeParse(json);
  return r.success ? r.data : null;
}

/** Parses a presence C2S text frame; null on bad JSON or schema mismatch. */
export function parsePresenceC2S(raw: string): PresenceC2S | null {
  return parseWith(PresenceC2SSchema, raw);
}

/** Parses a presence S2C text frame (client side); unknown types → null, so newer servers are safe. */
export function parsePresenceS2C(raw: string): PresenceS2C | null {
  return parseWith(PresenceS2CSchema, raw);
}
