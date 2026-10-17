import { z } from 'zod';
import { NAME_MAX_LENGTH, NAME_MIN_LENGTH, ROOM_CODE_REGEX } from '../constants.js';
import { RoomCodeSchema } from './common.js';
import { DirectMessageSchema, FriendStatusSchema } from './friends.js';

/**
 * Global presence socket (V07). Every page opens one; the room socket (`/ws`) stays as is.
 * Identity comes from the `vj_session` cookie on the upgrade request, never from a message.
 *
 * Both directions are `t`-discriminated unions so later tasks only add members:
 * - V08 matchmaking: C2S `queueJoin` / `queueLeave`, S2C `queue` / `matchFound`.
 * - V10 friends + DMs: S2C `friendStatus` / `friends` / `dm` / `invite` (actions go over REST,
 *   `shared/src/protocol/friends.ts`, so each one gets a status code).
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
  /** Users in the public matchmaking queue (V08). */
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

/**
 * V08: enter the public matchmaking queue under `name` (the room player name once matched).
 * Re-sending while queued only updates the name. Anonymous sockets queue per socket.
 */
export const PresenceQueueJoinSchema = z.object({
  t: z.literal('queueJoin'),
  name: z.string().trim().min(NAME_MIN_LENGTH).max(NAME_MAX_LENGTH),
});
/** V08: leave the queue (also implied by closing the presence socket). */
export const PresenceQueueLeaveSchema = z.object({ t: z.literal('queueLeave') });

export const PresenceC2SSchema = z.discriminatedUnion('t', [
  PresencePingSchema,
  PresenceQueueJoinSchema,
  PresenceQueueLeaveSchema,
]);
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
  /** `BLOCKED` (V08): vote-kicked from a public game, cannot queue for a few minutes. */
  code: z.enum(['INVALID', 'RATE_LIMITED', 'BLOCKED']),
  message: z.string(),
});

/**
 * V08: you are in the matchmaking queue (sent on join and every tick). `position` is 1-based,
 * `size` is everyone queued, `waitedMs` counts from your first join (kept across a requeue).
 */
export const PresenceQueueSchema = z.object({
  t: z.literal('queue'),
  position: count.optional(),
  size: count,
  waitedMs: count,
});
/** V08: you are no longer queued (left, matched elsewhere, or blocked). */
export const PresenceQueueLeftSchema = z.object({ t: z.literal('queueLeft') });
/**
 * V08: a public room was made for you. Store `token` as the room token
 * (`dub.token.<code>`) and open `/r/<code>`: the room socket joins with it.
 */
export const PresenceMatchFoundSchema = z.object({
  t: z.literal('matchFound'),
  code: z.string().regex(ROOM_CODE_REGEX),
  token: z.string().min(1).max(128),
});
/** V10: a friend went online / offline / into a game (sent to their online friends). */
export const PresenceFriendStatusSchema = z.object({
  t: z.literal('friendStatus'),
  userId: z.string(),
  status: FriendStatusSchema,
});
/** V10: friend lists changed (request received/accepted, friend removed): refetch `/api/friends`. */
export const PresenceFriendsSchema = z.object({ t: z.literal('friends') });
/** V10: a DM to or from you (sent to every tab of both sides). */
export const PresenceDmSchema = z.object({ t: z.literal('dm'), message: DirectMessageSchema });
/** V10: a friend invites you to their private lobby. */
export const PresenceInviteSchema = z.object({
  t: z.literal('invite'),
  from: z.string(),
  fromName: z.string(),
  code: RoomCodeSchema,
});

export const PresenceS2CSchema = z.discriminatedUnion('t', [
  PresenceCountsMsgSchema,
  PresencePongSchema,
  PresenceErrorSchema,
  PresenceQueueSchema,
  PresenceQueueLeftSchema,
  PresenceMatchFoundSchema,
  PresenceFriendStatusSchema,
  PresenceFriendsSchema,
  PresenceDmSchema,
  PresenceInviteSchema,
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
