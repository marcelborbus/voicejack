import { z } from 'zod';
import {
  AUDIO_MIMES,
  DUBBING_SECONDS_RANGE,
  MAX_OFFSET_MS,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  ROOM_CODE_REGEX,
  ROUNDS_RANGE,
  SHORT_DUBBING_MIN_SECONDS,
} from '../constants.js';

/** v2 (V14): per-player clips (`you.clip`, `ShowcaseItem.clip`, `RoundResultEntry.clip`). */
export const PROTOCOL_VERSION = 2;

export type PlayerId = string; // nanoid(12)
export type RoomCode = string; // /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/
export type SubmissionId = string; // nanoid(12), per player per round, unlinkable
export type ChunkId = string; // client crypto.randomUUID()
export type ServerTime = number; // epoch ms on the server clock
export type Phase = 'LOBBY' | 'DUBBING' | 'SHOWCASE' | 'ROUND_RESULTS' | 'FINAL';
export type AudioMime = 'audio/webm;codecs=opus' | 'audio/ogg;codecs=opus' | 'audio/mp4';

// ---------- primitive schemas ----------
export const PlayerIdSchema = z.string().min(1).max(64);
export const RoomCodeSchema = z.string().regex(ROOM_CODE_REGEX);
export const SubmissionIdSchema = z.string().min(1).max(64);
export const ChunkIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
export const PlayerNameSchema = z.string().trim().min(NAME_MIN_LENGTH).max(NAME_MAX_LENGTH);
export const AudioMimeSchema = z.enum(AUDIO_MIMES);
export const PhaseSchema = z.enum(['LOBBY', 'DUBBING', 'SHOWCASE', 'ROUND_RESULTS', 'FINAL']);

// ---------- settings ----------
export interface GameSettings {
  mode: 'normal' | 'extended';
  rounds: number; // normal: 3 (forced) | extended: 1..10
  dubbingSeconds: number; // normal: 210 (forced) | extended: 60..360, step 15
  tags: string[]; // extended only; [] = all clips
  /** Clip library (V05). Absent = the server's default library. Kept across mode switches. */
  libraryId?: string;
}

/**
 * Wire-level shape check. The lower dubbingSeconds bound is the ALLOW_SHORT_DUBBING floor;
 * the Room applies the exact rules (normal forces 3/210, extended 60..360 step 15).
 */
export const GameSettingsSchema = z.object({
  mode: z.enum(['normal', 'extended']),
  rounds: z.number().int().min(ROUNDS_RANGE.min).max(ROUNDS_RANGE.max),
  dubbingSeconds: z.number().int().min(SHORT_DUBBING_MIN_SECONDS).max(DUBBING_SECONDS_RANGE.max),
  tags: z.array(z.string().min(1).max(MAX_TAG_LENGTH)).max(MAX_TAGS),
  libraryId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
}) satisfies z.ZodType<GameSettings>;

// ---------- clips ----------
export interface ClipAttribution {
  author: string;
  source: string;
  license: string;
  licenseUrl?: string;
}
export interface ClipInfo {
  id: string;
  title: string;
  url: string; // "/clips/<file>"
  durationMs: number;
  width: number;
  height: number;
  posterUrl?: string;
  tags: string[];
  attribution: ClipAttribution;
}

export const ClipAttributionSchema = z.object({
  author: z.string(),
  source: z.string(),
  license: z.string(),
  licenseUrl: z.string().optional(),
}) satisfies z.ZodType<ClipAttribution>;

/** One entry of `CLIPS_DIR/manifest.json`. `file`/`poster` are relative to CLIPS_DIR. */
export const ClipManifestEntrySchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  title: z.string().min(1),
  file: z
    .string()
    .min(1)
    .regex(/^[^/\\]+$/, 'file must be a plain file name inside CLIPS_DIR'),
  durationMs: z.number().int().positive().max(60_000),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  poster: z
    .string()
    .regex(/^[^/\\]+$/)
    .optional(),
  tags: z.array(z.string().min(1).max(MAX_TAG_LENGTH)).default([]),
  attribution: ClipAttributionSchema,
  /** Owner-provided clip (not redistributable, gitignored, kept by fetch-clips.mjs). */
  local: z.boolean().optional(),
});
export type ClipManifestEntry = z.infer<typeof ClipManifestEntrySchema>;

export const ClipManifestSchema = z
  .object({
    clips: z.array(ClipManifestEntrySchema),
  })
  .refine((m) => new Set(m.clips.map((c) => c.id)).size === m.clips.length, {
    message: 'duplicate clip id',
  });
export type ClipManifest = z.infer<typeof ClipManifestSchema>;

// ---------- players ----------
export interface PlayerPublic {
  id: PlayerId;
  name: string;
  isHost: boolean;
  connected: boolean;
  micOk: boolean;
  ready: boolean;
  dubDone: boolean; // only meaningful in DUBBING
  totalScore: number;
  /** Server-side bot (V01, dev test mode): never in voice, excluded from Elo. Absent = false. */
  isBot?: boolean;
  /**
   * V13, public rooms only: the player opted in to voice ("tap to talk" / "tap to listen").
   * Peer connections (which expose IPs) exist only between two opted-in players. Absent in
   * private rooms, where everyone connects.
   */
  voiceOptIn?: boolean;
}

// ---------- chunks ----------
export interface ChunkMeta {
  id: ChunkId;
  startMs: number; // position on the clip timeline (immutable)
  offsetMs: number; // leading audio to skip (recorder latency compensation)
  durationMs: number; // audible duration after offset
  mime: AudioMime;
  bytes: number;
}
export interface ChunkRef extends ChunkMeta {
  url: string; // GET path, see REST
}

export const ChunkMetaSchema = z.object({
  id: ChunkIdSchema,
  startMs: z.number().nonnegative(),
  offsetMs: z.number().min(0).max(MAX_OFFSET_MS),
  durationMs: z.number().positive(),
  mime: AudioMimeSchema,
  bytes: z.number().int().nonnegative(),
}) satisfies z.ZodType<ChunkMeta>;

// ---------- showcase / results ----------
export interface ShowcaseItem {
  submissionId: SubmissionId;
  index: number;
  total: number;
  /** V14: the clip this dub was made for (each player dubs a different one). */
  clip: ClipInfo;
  chunks: ChunkRef[];
  status: 'LOADING' | 'PLAYING' | 'LOCKED';
  startAt: ServerTime | null; // set when PLAYING
  lockAt: ServerTime | null;
  votesCast: number;
  votersExpected: number;
}
export type ShowcaseStatus = ShowcaseItem['status'];

export interface RoundResultEntry {
  submissionId: SubmissionId;
  playerId: PlayerId;
  name: string;
  /** V14: the clip this player dubbed this round. */
  clip: ClipInfo;
  avg: number | null;
  votes: number;
  points: number;
  empty: boolean;
}
export interface RoundResult {
  round: number;
  entries: RoundResultEntry[]; // sorted desc
}

export interface FinalStanding {
  playerId: PlayerId;
  name: string;
  total: number;
  roundWins: number;
}
export interface BestDub {
  round: number;
  clip: ClipInfo;
  submissionId: SubmissionId;
  playerId: PlayerId;
  chunks: ChunkRef[];
  points: number;
}
export interface FinalResult {
  winners: PlayerId[];
  standings: FinalStanding[];
  bestDub: BestDub | null;
}

export interface Limits {
  maxPlayers: number;
  maxChunksPerSubmission: number; // 8, 40
  maxChunkBytes: number;
  maxSubmissionBytes: number; // 2 MiB, 16 MiB
  minChunkMs: number; // 300
}

export interface YouState {
  playerId: PlayerId;
  submissionId: SubmissionId | null; // own, current round
  /** V14: own clip of the current round (DUBBING, SHOWCASE, ROUND_RESULTS), else null. */
  clip: ClipInfo | null;
  manifest: ChunkMeta[]; // server's view of own manifest (restore after reload)
  uploaded: ChunkId[];
  vote: number | null; // own vote on current showcase item
  isOwnItem: boolean; // current showcase item is mine → slider disabled
  canStart: boolean;
  startBlockers: string[]; // host UI
  /** Host may add/remove bots now (LOBBY, server runs with DEV_BOTS=1 or host is admin). */
  canManageBots: boolean;
}

/** V08: `private` rooms have a human host; `public` (matchmade) rooms are hosted by the server. */
export type RoomKind = 'private' | 'public';

/** V08: what only public rooms have (ready check + moderation). */
export interface PublicRoomState {
  /** LOBBY: the ready-check deadline; whoever is not ready then goes back to the queue. */
  readyEndsAt: ServerTime | null;
  /** Kick votes against each player (only players with at least one vote are listed). */
  kickVotes: Record<PlayerId, number>;
  /** Votes needed to kick a connected player right now (majority of the other humans). */
  kickNeeded: number;
  /** Players you voted to kick. */
  youKickVoted: PlayerId[];
  /** Players you already reported in this room. */
  youReported: PlayerId[];
}

export interface RoomSnapshot {
  rev: number;
  code: RoomCode;
  phase: Phase;
  kind: RoomKind;
  /** Only for `kind: 'public'`. */
  public: PublicRoomState | null;
  hostId: PlayerId;
  settings: GameSettings;
  availableTags: string[];
  /** Clips in the selected library matching `settings.tags` (V14: start needs >= players). */
  clipCount: number;
  players: PlayerPublic[]; // join order
  round: number; // 0-based; -1 in LOBBY
  totalRounds: number;
  phaseEndsAt: ServerTime | null; // DUBBING deadline, ROUND_RESULTS auto-advance
  showcase: ShowcaseItem | null;
  roundResult: RoundResult | null;
  final: FinalResult | null;
  you: YouState;
}

// ---------- WebRTC (DOM-free mirrors of RTCIceCandidateInit / RTCIceServer) ----------
export interface IceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}
export const IceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
}) satisfies z.ZodType<IceServer>;
