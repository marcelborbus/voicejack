import type {
  ChunkId,
  ChunkMeta,
  ClipInfo,
  ErrorCode,
  Limits,
  PlayerId,
  RoomCode,
  RoomKind,
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

/** Clip libraries as a Room sees them (implemented by ClipLibrary, V05). */
export interface RoomLibrary {
  defaultId(): string | null;
  /** Playable clips of the library, or null if it does not exist. */
  clipsOf(libraryId: string): readonly ClipInfo[] | null;
  /** May a host with account `userId` play this library? (official: everyone; V06 private: owner) */
  canUse(libraryId: string, userId: string | undefined): boolean;
}

/** Why a player left the room's roster (V08 adds vote-kicks and missed ready checks). */
export type RemoveReason = 'kick' | 'drop' | 'leave' | 'votekick' | 'requeue';

/** V08: a report filed in a public room (stored in the `reports` table). */
export interface PlayerReport {
  code: RoomCode;
  reporterId: PlayerId;
  reporterName: string;
  reporterUserId: string | null;
  reportedId: PlayerId;
  reportedName: string;
  reportedUserId: string | null;
  reason: string;
}

/** V09: one player at FINAL, as reported to `onFinal`. */
export interface FinalSeat {
  playerId: PlayerId;
  userId: string | null;
  isBot: boolean;
  total: number;
  roundWins: number;
}

export interface RoomDeps {
  code: RoomCode;
  /** V08: `public` = matchmade, server-hosted (default `private`). */
  kind?: RoomKind;
  clock: Clock;
  scheduler: Scheduler;
  /** Delivers a message to one player's socket (no-op if not connected). */
  emit(playerId: PlayerId, msg: S2C): void;
  /** Fallback clip set (no `library`, or its default library is gone). */
  clips: readonly ClipInfo[];
  /** V05: clip libraries; `settings.libraryId` picks one (default: `library.defaultId()`). */
  library?: RoomLibrary;
  timings: Timings;
  options: RoomOptions;
  /** Upload index (ChunkStore). Defaults to "nothing uploaded". */
  isUploaded?(submissionId: SubmissionId, chunkId: ChunkId): boolean;
  /** Called after a player is removed from the room (kick, lobby drop, leave). */
  onPlayerRemoved?(playerId: PlayerId, reason: RemoveReason): void;
  /** V08 public: the player missed the ready check and was removed; put them back in the queue. */
  onRequeue?(playerId: PlayerId, userId: string | null): void;
  /** V08 public: the player was vote-kicked (the matchmaker blocks them for a while). */
  onVoteKicked?(playerId: PlayerId, userId: string | null): void;
  /** V08 public: a player reported another one. */
  onReport?(report: PlayerReport): void;
  /**
   * V09: the game reached FINAL. `seats` = everyone still on the roster (disconnected players
   * included; vote-kicked ones are gone), in final standings order. The room's Elo is
   * recorded here (synchronously, before the FINAL snapshot goes out).
   */
  onFinal?(seats: FinalSeat[]): void;
  /** A bot player was created (connected) by the room; attach its BotPlayer connection here. */
  onBotAdded?(playerId: PlayerId): void;
  /**
   * V05 hook: admins may add bots without DEV_BOTS. Always false until accounts exist.
   * Bots are private-room only: public rooms never allow them (V08).
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
  /** V14: the clip this player was dealt for the round. */
  clip: ClipInfo;
  /** Latest manifest the player sent (sorted by startMs). */
  manifest: ChunkMeta[];
  /** `manifest ∩ uploaded`, set at finalize. */
  chunks: ChunkMeta[] | null;
  votes: number[];
}
