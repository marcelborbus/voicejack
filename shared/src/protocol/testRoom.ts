import { z } from 'zod';
import {
  DUBBING_SECONDS_RANGE,
  MAX_BOTS,
  NAME_MAX_LENGTH,
  NORMAL_SETTINGS,
  ROUNDS_RANGE,
  SHORT_DUBBING_MIN_SECONDS,
} from '../constants.js';
import type { RoomCode } from './common.js';

// v1.2 #46: admin test game with bots, in prod (no DEV_BOTS needed).
// POST /api/admin/test-room (Authelia-gated like every /api/admin route) creates a private room
// with the caller as host, applies the settings (short dubbing times allowed) and seats the
// bots. The client stores `token` as `dub.token.<CODE>` (like matchmaking) and opens `/r/CODE`.
// Test rooms never count in analytics or Elo.

export const TEST_ROOM_PATH = '/api/admin/test-room';

export const TestRoomBodySchema = z.object({
  bots: z.number().int().min(1).max(MAX_BOTS),
  /** Official library id; default = the default library. */
  libraryId: z.string().min(1).max(64).optional(),
  rounds: z.number().int().min(ROUNDS_RANGE.min).max(ROUNDS_RANGE.max).default(1),
  dubbingSeconds: z
    .number()
    .int()
    .min(SHORT_DUBBING_MIN_SECONDS)
    .max(DUBBING_SECONDS_RANGE.max)
    .default(NORMAL_SETTINGS.dubbingSeconds), // v1.2 #47: the normal 210 s
  /** Host name shown in the room (default: the account name, else "Admin"). */
  name: z.string().trim().min(1).max(NAME_MAX_LENGTH).optional(),
  /**
   * #53: start the game without Ready/Start clicks: once the host is connected and their mic
   * passed (or failed, or 3 s went by: testing without a mic works).
   */
  autoStart: z.boolean().default(true),
});
export type TestRoomBody = z.input<typeof TestRoomBodySchema>;

export interface TestRoomResponse {
  code: RoomCode;
  token: string;
  /** Snippets the bots can send right now (the library pool may still be generating). */
  botSounds: number;
}
