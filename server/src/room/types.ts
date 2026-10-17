import type {
  ChunkId,
  ChunkMeta,
  ClipInfo,
  ErrorCode,
  Limits,
  PlayerId,
  RoomCode,
  S2C,
  SubmissionId,
} from '@dub/shared';
import type { Timings } from '../config.js';

export interface Clock {
  now(): number;
}

/** setTimeout wrapper so vitest fake timers (or a manual scheduler) can drive the room. */
export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RoomOptions {
  allowSolo: boolean;
  allowShortDubbing: boolean;
  maxPlayers: number;
  limits: Limits;
  /** V01 dev test mode: the host may add server-side bots (env DEV_BOTS=1). */
  devBots?: boolean;
}

export interface RoomDeps {
  code: RoomCode;
  clock: Clock;
  scheduler: Scheduler;
  /** Delivers a message to one player's socket (no-op if not connected). */
  emit(playerId: PlayerId, msg: S2C): void;
  clips: readonly ClipInfo[];
  timings: Timings;
  options: RoomOptions;
  /** Upload index (ChunkStore). Defaults to "nothing uploaded". */
  isUploaded?(submissionId: SubmissionId, chunkId: ChunkId): boolean;
  /** Called after a player is removed from the room (kick, lobby drop, leave). */
  onPlayerRemoved?(playerId: PlayerId, reason: 'kick' | 'drop' | 'leave'): void;
  /** A bot player was created (connected) by the room; attach its BotPlayer connection here. */
  onBotAdded?(playerId: PlayerId): void;
  /**
   * V05 hook: admins may add bots without DEV_BOTS. Always false until accounts exist.
   * TODO(V08): bots stay limited to private rooms once public rooms exist.
   */
  isAdmin?(playerId: PlayerId): boolean;
  rng?: () => number;
  /** nanoid(12) by default (player and submission ids). */
  newId?: () => string;
  /** 32 random bytes, base64url, by default. */
  newToken?: () => string;
}

export interface RoomError {
  code: ErrorCode;
  message: string;
}

/** `null` = accepted. */
export type Outcome = RoomError | null;

export interface Submission {
  id: SubmissionId;
  playerId: PlayerId;
  round: number;
  /** Latest manifest the player sent (sorted by startMs). */
  manifest: ChunkMeta[];
  /** `manifest ∩ uploaded`, set at finalize. */
  chunks: ChunkMeta[] | null;
  votes: number[];
}
