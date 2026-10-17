import type { AudioMime, GameSettings, Limits } from './protocol/common.js';

export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_REGEX = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

export const MAX_ROOMS = 30;
export const MAX_PLAYERS = 8;
/** Dev/test bots per room (V01); a room still holds at most MAX_PLAYERS players in total. */
export const MAX_BOTS = MAX_PLAYERS - 1;

export const NAME_MIN_LENGTH = 1;
export const NAME_MAX_LENGTH = 20;

export const VOTE_MIN = 0;
export const VOTE_MAX = 10;

/** Max leading audio the recorder latency compensation may skip. */
export const MAX_OFFSET_MS = 1000;

/** WS message size cap (gateway) and per-`rtc` payload cap (relay). */
export const WS_MAX_MESSAGE_BYTES = 32 * 1024;
export const RTC_MAX_BYTES = 16 * 1024;

export const AUDIO_MIMES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/mp4',
] as const satisfies readonly AudioMime[];

/** Normal mode forces these values. */
export const NORMAL_SETTINGS: Readonly<GameSettings> = Object.freeze({
  mode: 'normal',
  rounds: 3,
  dubbingSeconds: 210,
  tags: [],
});

/** Extended-mode ranges. */
export const ROUNDS_RANGE = { min: 1, max: 10, step: 1 } as const;
export const DUBBING_SECONDS_RANGE = { min: 60, max: 360, step: 15 } as const;
/** Lower bound for dubbingSeconds when the server runs with ALLOW_SHORT_DUBBING (tests/e2e). */
export const SHORT_DUBBING_MIN_SECONDS = 5;
export const MAX_TAGS = 32;
export const MAX_TAG_LENGTH = 32;

export const LIMITS: Readonly<Limits> = Object.freeze({
  maxPlayers: MAX_PLAYERS,
  maxChunksPerSubmission: 40,
  maxChunkBytes: 2 * 1024 * 1024,
  maxSubmissionBytes: 16 * 1024 * 1024,
  minChunkMs: 300,
});

/** Header carrying the player token on REST calls (`?k=` query param also accepted on GET). */
export const PLAYER_TOKEN_HEADER = 'X-Player-Token';
export const PLAYER_TOKEN_QUERY = 'k';
