import { z } from 'zod';
import { LIMITS, RTC_MAX_BYTES, VOTE_MAX, VOTE_MIN } from '../constants.js';
import {
  ChunkMetaSchema,
  GameSettingsSchema,
  PlayerIdSchema,
  PlayerNameSchema,
  RoomCodeSchema,
  SubmissionIdSchema,
} from './common.js';

// ---------- WebRTC signaling payload ----------
export const RtcSignalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('description'),
    description: z.object({
      type: z.enum(['offer', 'answer', 'rollback']),
      sdp: z.string().max(RTC_MAX_BYTES).optional(),
    }),
  }),
  z.object({
    kind: z.literal('candidate'),
    candidate: z
      .object({
        candidate: z.string().max(4096).optional(),
        sdpMid: z.string().max(256).nullable().optional(),
        sdpMLineIndex: z.number().int().nonnegative().nullable().optional(),
        usernameFragment: z.string().max(256).nullable().optional(),
      })
      .nullable(),
  }),
]);
export type RtcSignal = z.infer<typeof RtcSignalSchema>;

const round = z.number().int().nonnegative();

// ---------- client → server ----------
export const HelloSchema = z.object({
  t: z.literal('hello'),
  v: z.number().int(),
  code: RoomCodeSchema,
  token: z.string().min(1).max(128).optional(),
  name: PlayerNameSchema.optional(), // required without token (checked by the gateway)
});
export const PingSchema = z.object({ t: z.literal('ping'), c: z.number() }); // client performance.now()
export const SetNameSchema = z.object({ t: z.literal('setName'), name: PlayerNameSchema }); // LOBBY
export const MicStatusSchema = z.object({ t: z.literal('micStatus'), ok: z.boolean() });
export const SetReadySchema = z.object({ t: z.literal('setReady'), ready: z.boolean() });
export const UpdateSettingsSchema = z.object({
  t: z.literal('updateSettings'),
  settings: GameSettingsSchema.partial(),
}); // host, LOBBY
export const KickSchema = z.object({ t: z.literal('kick'), playerId: PlayerIdSchema }); // host, LOBBY
export const StartGameSchema = z.object({ t: z.literal('startGame') }); // host, LOBBY
export const ManifestSchema = z.object({
  t: z.literal('manifest'),
  round,
  chunks: z.array(ChunkMetaSchema).max(LIMITS.maxChunksPerSubmission),
}); // DUBBING, full replace
export const DubDoneSchema = z.object({ t: z.literal('dubDone'), round, done: z.boolean() }); // DUBBING
export const PreloadedSchema = z.object({
  t: z.literal('preloaded'),
  submissionId: SubmissionIdSchema,
}); // SHOWCASE/LOADING
export const VoteSchema = z.object({
  t: z.literal('vote'),
  submissionId: SubmissionIdSchema,
  score: z.number().int().min(VOTE_MIN).max(VOTE_MAX),
}); // PLAYING
export const AdvanceSchema = z.object({ t: z.literal('advance') }); // host, ROUND_RESULTS
export const BackToLobbySchema = z.object({ t: z.literal('backToLobby') }); // host, FINAL
export const RtcC2SSchema = z.object({
  t: z.literal('rtc'),
  to: PlayerIdSchema,
  data: RtcSignalSchema,
}); // relayed, ≤16 KB
export const LeaveSchema = z.object({ t: z.literal('leave') });
/** Dev test mode (V01): host adds a server-side bot / removes one (default: the last added). */
export const AddBotSchema = z.object({ t: z.literal('addBot') }); // host, LOBBY
export const RemoveBotSchema = z.object({
  t: z.literal('removeBot'),
  playerId: PlayerIdSchema.optional(),
}); // host, LOBBY

export const C2SSchema = z.discriminatedUnion('t', [
  HelloSchema,
  PingSchema,
  SetNameSchema,
  MicStatusSchema,
  SetReadySchema,
  UpdateSettingsSchema,
  KickSchema,
  StartGameSchema,
  ManifestSchema,
  DubDoneSchema,
  PreloadedSchema,
  VoteSchema,
  AdvanceSchema,
  BackToLobbySchema,
  RtcC2SSchema,
  LeaveSchema,
  AddBotSchema,
  RemoveBotSchema,
]);
export type C2S = z.infer<typeof C2SSchema>;
export type C2SType = C2S['t'];
export type C2SOf<T extends C2SType> = Extract<C2S, { t: T }>;

/** Parse a raw WS text frame. Returns `null` on bad JSON or schema mismatch. */
export function parseC2S(raw: string): C2S | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = C2SSchema.safeParse(json);
  return r.success ? r.data : null;
}
