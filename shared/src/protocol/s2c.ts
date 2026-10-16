import type { RtcSignal } from './c2s.js';
import type {
  IceServer,
  Limits,
  PlayerId,
  RoomSnapshot,
  ServerTime,
  SubmissionId,
} from './common.js';

export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'GAME_IN_PROGRESS'
  | 'BAD_TOKEN'
  | 'VERSION'
  | 'NOT_HOST'
  | 'BAD_PHASE'
  | 'INVALID'
  | 'RATE_LIMITED'
  | 'START_BLOCKED'
  | 'SELF_VOTE'
  | 'LIMIT';

export const ERROR_CODES = [
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'GAME_IN_PROGRESS',
  'BAD_TOKEN',
  'VERSION',
  'NOT_HOST',
  'BAD_PHASE',
  'INVALID',
  'RATE_LIMITED',
  'START_BLOCKED',
  'SELF_VOTE',
  'LIMIT',
] as const satisfies readonly ErrorCode[];

export type S2C =
  | {
      t: 'welcome';
      v: number;
      playerId: PlayerId;
      token: string;
      serverNow: ServerTime;
      iceServers: IceServer[];
      limits: Limits;
    }
  | { t: 'state'; state: RoomSnapshot; serverNow: ServerTime }
  | { t: 'pong'; c: number; s: ServerTime }
  | { t: 'rtc'; from: PlayerId; data: RtcSignal }
  | { t: 'voteAck'; submissionId: SubmissionId; score: number }
  | { t: 'error'; code: ErrorCode; message: string; fatal?: boolean } // fatal → client stops reconnecting
  | { t: 'kicked' };

export type S2CType = S2C['t'];
export type S2COf<T extends S2CType> = Extract<S2C, { t: T }>;
