import { z } from 'zod';
import type { ChunkId, Phase, RoomCode, SubmissionId } from './common.js';
import { PlayerNameSchema } from './common.js';
import type { ErrorCode } from './s2c.js';

export const WS_PATH = '/ws';

/** URL builders. Server route patterns use the `*Route` constants. */
export const paths = {
  rooms: () => '/api/rooms',
  room: (code: RoomCode) => `/api/rooms/${encodeURIComponent(code)}`,
  chunkUpload: (code: RoomCode, round: number, chunkId: ChunkId) =>
    `/api/rooms/${encodeURIComponent(code)}/rounds/${round}/chunks/${encodeURIComponent(chunkId)}`,
  chunk: (code: RoomCode, round: number, subId: SubmissionId, chunkId: ChunkId) =>
    `/api/rooms/${encodeURIComponent(code)}/rounds/${round}/subs/${encodeURIComponent(subId)}/chunks/${encodeURIComponent(chunkId)}`,
  clip: (file: string) => `/clips/${encodeURIComponent(file)}`,
  health: () => '/api/health',
  me: () => '/api/me',
  authRequest: () => '/api/auth/request',
  authVerify: () => '/api/auth/verify',
  authLogout: () => '/api/auth/logout',
} as const;

export const routes = {
  rooms: '/api/rooms',
  room: '/api/rooms/:code',
  chunkUpload: '/api/rooms/:code/rounds/:round/chunks/:chunkId',
  chunk: '/api/rooms/:code/rounds/:round/subs/:subId/chunks/:chunkId',
  clip: '/clips/:file',
  /** v1.2 #47: one snippet of the bot sound pool (content-addressed, see `botVoice`). */
  botSound: '/api/bot-sounds/:key',
  health: '/api/health',
  me: '/api/me',
  authRequest: '/api/auth/request',
  authVerify: '/api/auth/verify',
  authLogout: '/api/auth/logout',
} as const;

/** Every REST error body. */
export interface ApiError {
  error: ErrorCode;
  message: string;
}

// POST /api/rooms
export const CreateRoomBodySchema = z.object({ name: PlayerNameSchema });
export type CreateRoomBody = z.infer<typeof CreateRoomBodySchema>;
export interface CreateRoomResponse {
  code: RoomCode;
  playerId: string;
  token: string;
}

// GET /api/rooms/:code
export interface RoomInfoResponse {
  code: RoomCode;
  phase: Phase;
  playerCount: number;
  maxPlayers: number;
  joinable: boolean;
}

// POST /api/rooms/:code/rounds/:round/chunks/:chunkId  (raw audio body)
export interface ChunkUploadResponse {
  id: ChunkId;
  bytes: number;
}

// GET /api/health
export interface HealthResponse {
  ok: boolean;
  rooms: number;
  players: number;
  uptimeS: number;
}

// GET /api/me — the browser's profile. Creates a guest user + `vj_session` cookie (HttpOnly,
// 30 d) on first call. 429 if guest creation is rate limited.
export interface MeUser {
  id: string;
  kind: 'guest' | 'registered';
  /** Last name played under; null until the first room join. */
  displayName: string | null;
  /** Only the user's own email (registered users); null for guests. */
  email: string | null;
  elo: number;
  publicGamesPlayed: number;
}
export interface MeResponse {
  user: MeUser;
}

// PATCH /api/me {displayName} → MeResponse. DELETE /api/me → MeResponse of a fresh guest
// (the account is anonymized, every session ends; V04).
export const UpdateMeBodySchema = z.object({ displayName: PlayerNameSchema });
export type UpdateMeBody = z.infer<typeof UpdateMeBodySchema>;

// POST /api/auth/request {email} → 202 (always, whether or not the account exists; 429 when
// rate limited: 3 per address per 15 min, 10 per IP per hour). Mails a 15-min single-use link
// to GET /api/auth/verify?t=…, a confirm page whose button POSTs the token (mail scanners
// that prefetch the link don't burn it) and redirects to `/?login=ok` (or `/?login=invalid`).
export const EMAIL_MAX_LENGTH = 254;
export const AuthRequestBodySchema = z.object({
  email: z.string().trim().toLowerCase().max(EMAIL_MAX_LENGTH).pipe(z.email()),
});
export type AuthRequestBody = z.infer<typeof AuthRequestBodySchema>;

// POST /api/auth/logout → MeResponse of a fresh guest (new session cookie).
