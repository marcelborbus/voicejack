import { z } from 'zod';
import { PlayerIdSchema, RoomCodeSchema, type PlayerId, type RoomCode } from './common.js';

// Friends, invites and direct messages (V10). Registered users only: every route answers 403
// for guests. Live updates arrive over `/ws/presence` (`friendStatus`, `friends`, `dm`, `invite`).
//
// Privacy: account ids of *friends* are visible to each other (DMs are addressed by them).
// Pending requests and blocks are addressed by an opaque `ref` instead, so sending, receiving
// or declining a request never reveals the other side's account id, and a room player is only
// ever addressed by its room `playerId` (`POST /api/friends/from-room`).

export const DM_MAX_LENGTH = 500;
export const DM_RETENTION_DAYS = 90;
export const DM_PAGE_SIZE = 50;
export const FRIEND_REQUESTS_PER_DAY = 30;
export const DMS_PER_MINUTE = 20;
export const INVITES_PER_MINUTE = 10;
export const REPORT_REASON_MAX_LENGTH = 500;

export type FriendStatus = 'offline' | 'online' | 'inGame';
export const FriendStatusSchema = z.enum(['offline', 'online', 'inGame']);

export interface FriendInfo {
  userId: string;
  name: string;
  status: FriendStatus;
  /** Unread DMs from this friend. */
  unread: number;
  since: number;
}
/** A pending request or a block; `ref` addresses it in the routes below. */
export interface FriendRefInfo {
  ref: string;
  name: string;
  at: number;
}
// GET /api/friends
export interface FriendsResponse {
  friends: FriendInfo[];
  incoming: FriendRefInfo[];
  outgoing: FriendRefInfo[];
  blocked: FriendRefInfo[];
}

/** How the caller relates to a room player (only registered humans other than the caller). */
export type RoomRelation = 'none' | 'outgoing' | 'incoming' | 'friend';
// GET /api/friends/room/:code — only when the caller is a player in that room.
export interface RoomRelationsResponse {
  players: Record<PlayerId, RoomRelation>;
}

// POST /api/friends/from-room {code, playerId}: friend request to a player you share a room with.
export const AddFromRoomBodySchema = z.object({ code: RoomCodeSchema, playerId: PlayerIdSchema });
export type AddFromRoomBody = z.infer<typeof AddFromRoomBodySchema>;
/** `accepted`: they had already asked you, so you are friends now. Never carries an id. */
export interface AddFromRoomResponse {
  result: 'requested' | 'accepted' | 'already';
}

// POST /api/friends/requests/:ref {action}
export const RequestActionBodySchema = z.object({
  action: z.enum(['accept', 'decline', 'cancel', 'block']),
});
export type RequestActionBody = z.infer<typeof RequestActionBodySchema>;

export const DirectMessageSchema = z.object({
  id: z.number().int(),
  from: z.string(),
  to: z.string(),
  body: z.string(),
  at: z.number(),
  readAt: z.number().nullable(),
});
export type DirectMessage = z.infer<typeof DirectMessageSchema>;

// GET /api/friends/:userId/messages?before=<id> → newest page, oldest first; marks it read.
export interface MessagesResponse {
  messages: DirectMessage[];
  /** Older messages exist (ask again with `before` = the first id). */
  more: boolean;
}
// POST /api/friends/:userId/messages {body} → {message}
export const SendMessageBodySchema = z.object({
  body: z
    .string()
    .min(1)
    .max(DM_MAX_LENGTH * 2),
});
export interface SendMessageResponse {
  message: DirectMessage;
}
// POST /api/friends/:userId/invite {code}: only while you host that private room in LOBBY.
export const InviteBodySchema = z.object({ code: RoomCodeSchema });
// POST /api/friends/:userId/report {reason, messageId?}
export const ReportBodySchema = z.object({
  reason: z.string().trim().min(1).max(REPORT_REASON_MAX_LENGTH),
  messageId: z.number().int().positive().optional(),
});
export type ReportBody = z.infer<typeof ReportBodySchema>;

// Control characters (except newline), bidi overrides/isolates, zero-width joiners & co.
// eslint-disable-next-line no-control-regex
const STRIP_RE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;

/** DM text as stored: control chars stripped, ≤ 2 consecutive newlines, trimmed. '' = reject. */
export function sanitizeDmBody(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(STRIP_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const friendPaths = {
  friends: () => '/api/friends',
  fromRoom: () => '/api/friends/from-room',
  room: (code: RoomCode) => `/api/friends/room/${encodeURIComponent(code)}`,
  request: (ref: string) => `/api/friends/requests/${encodeURIComponent(ref)}`,
  block: (ref: string) => `/api/friends/blocks/${encodeURIComponent(ref)}`,
  friend: (userId: string) => `/api/friends/${encodeURIComponent(userId)}`,
  blockFriend: (userId: string) => `/api/friends/${encodeURIComponent(userId)}/block`,
  messages: (userId: string, before?: number) =>
    `/api/friends/${encodeURIComponent(userId)}/messages${before ? `?before=${before}` : ''}`,
  read: (userId: string) => `/api/friends/${encodeURIComponent(userId)}/read`,
  invite: (userId: string) => `/api/friends/${encodeURIComponent(userId)}/invite`,
  report: (userId: string) => `/api/friends/${encodeURIComponent(userId)}/report`,
} as const;

export const friendRoutes = {
  friends: '/api/friends',
  fromRoom: '/api/friends/from-room',
  room: '/api/friends/room/:code',
  request: '/api/friends/requests/:ref',
  block: '/api/friends/blocks/:ref',
  friend: '/api/friends/:userId',
  blockFriend: '/api/friends/:userId/block',
  messages: '/api/friends/:userId/messages',
  read: '/api/friends/:userId/read',
  invite: '/api/friends/:userId/invite',
  report: '/api/friends/:userId/report',
} as const;
