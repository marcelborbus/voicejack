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
} as const;

export const routes = {
  rooms: '/api/rooms',
  room: '/api/rooms/:code',
  chunkUpload: '/api/rooms/:code/rounds/:round/chunks/:chunkId',
  chunk: '/api/rooms/:code/rounds/:round/subs/:subId/chunks/:chunkId',
  clip: '/clips/:file',
  health: '/api/health',
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
