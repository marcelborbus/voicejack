import { randomUUID } from 'node:crypto';
import {
  LIMITS,
  type AudioMime,
  type C2S,
  type ChunkMeta,
  type PlayerId,
  type RoomSnapshot,
  type S2C,
  type SubmissionId,
} from '@dub/shared';
import type { Connection } from '../room/RoomManager.js';
import { Timers } from '../room/timers.js';
import type { Clock, Outcome, RoomError, Scheduler } from '../room/types.js';

/** One pre-cut audio snippet a bot can "record". */
export interface BotSound {
  name: string;
  durationMs: number;
  mime: AudioMime;
  data: Buffer;
}

/** The slice of the Room API a bot drives (same calls the gateway makes for a socket). */
export interface BotRoom {
  handle(playerId: PlayerId, msg: C2S): Outcome;
  uploadTarget(playerId: PlayerId, round: number): { submissionId: SubmissionId } | RoomError;
}

export interface BotPlayerDeps {
  room: BotRoom;
  playerId: PlayerId;
  clock: Clock;
  scheduler: Scheduler;
  sounds: readonly BotSound[];
  /** Stores one chunk exactly like an HTTP upload (ChunkStore.put bound to the room). */
  put(
    round: number,
    submissionId: SubmissionId,
    chunkId: string,
    mime: AudioMime,
    data: Buffer,
  ): Promise<unknown>;
  rng?: () => number;
  onError?(e: unknown): void;
}

/** Bot tuning; exported for tests. */
export const BOT = {
  micDelayMs: [150, 600],
  readyDelayMs: [300, 1200],
  chunks: [2, 5],
  /** Chunk "recordings" land in this fraction of the remaining dubbing time. */
  dubWindow: [0.1, 0.6],
  doneDelayMs: [300, 1500],
  preloadDelayMs: [20, 150],
  /** Vote lands at this fraction of the clip's playback. */
  voteAt: [0.3, 0.95],
  score: [3, 9],
} as const;

/**
 * Server-side player for dev/test mode (V01). Implements `Connection`, so the room's normal
 * per-recipient snapshots arrive in `send`; it reacts by calling the Room API on a timer
 * (never synchronously: `send` runs inside a room mutation). Never takes part in voice.
 */
export class BotPlayer implements Connection {
  private readonly timers: Timers;
  private readonly rng: () => number;
  private closed = false;
  private dubRound = -1;
  private readonly preloaded = new Set<SubmissionId>();
  private readonly voted = new Set<SubmissionId>();

  constructor(private readonly deps: BotPlayerDeps) {
    this.timers = new Timers(deps.scheduler);
    this.rng = deps.rng ?? Math.random;
  }

  send(msg: S2C): void {
    if (this.closed || msg.t !== 'state') return;
    this.onState(msg.state);
  }

  close(): void {
    this.closed = true;
    this.timers.clearAll();
  }

  private between([lo, hi]: readonly [number, number]): number {
    return lo + this.rng() * (hi - lo);
  }

  private int([lo, hi]: readonly [number, number]): number {
    return lo + Math.floor(this.rng() * (hi - lo + 1));
  }

  private act(msg: C2S): void {
    if (this.closed) return;
    this.deps.room.handle(this.deps.playerId, msg);
  }

  private onState(s: RoomSnapshot): void {
    const me = s.players.find((p) => p.id === this.deps.playerId);
    if (!me) return;
    switch (s.phase) {
      case 'LOBBY':
        this.dubRound = -1;
        if (!me.micOk && !this.timers.has('mic')) {
          this.timers.set('mic', this.between(BOT.micDelayMs), () =>
            this.act({ t: 'micStatus', ok: true }),
          );
        } else if (me.micOk && !me.ready && !this.timers.has('ready')) {
          this.timers.set('ready', this.between(BOT.readyDelayMs), () =>
            this.act({ t: 'setReady', ready: true }),
          );
        }
        return;
      case 'DUBBING':
        if (s.round !== this.dubRound) {
          this.dubRound = s.round;
          this.planDub(s);
        }
        return;
      case 'SHOWCASE':
        this.onShowcase(s);
        return;
      default:
        return;
    }
  }

  /** 2–5 snippets at random clip positions, "recorded" over the first part of the phase. */
  private planDub(s: RoomSnapshot): void {
    const round = s.round;
    const clipMs = s.you.clip?.durationMs ?? 0; // V14: own clip
    const now = this.deps.clock.now();
    const left = Math.max(1000, (s.phaseEndsAt ?? now + 10_000) - now);
    const sounds = this.deps.sounds;
    const n = sounds.length > 0 ? this.int(BOT.chunks) : 0;
    const times = Array.from({ length: n }, () => left * this.between(BOT.dubWindow)).sort(
      (a, b) => a - b,
    );
    const manifest: ChunkMeta[] = [];
    let pending = n;
    const finish = (): void => {
      this.timers.set(`done:${round}`, this.between(BOT.doneDelayMs), () =>
        this.act({ t: 'dubDone', round, done: true }),
      );
    };
    if (n === 0) {
      finish();
      return;
    }
    times.forEach((at, i) => {
      this.timers.set(`chunk:${round}:${i}`, at, () => {
        void this.recordChunk(round, clipMs, manifest)
          .catch((e: unknown) => this.deps.onError?.(e))
          .finally(() => {
            if (--pending === 0 && !this.closed) finish();
          });
      });
    });
  }

  private async recordChunk(round: number, clipMs: number, manifest: ChunkMeta[]): Promise<void> {
    const sound = this.deps.sounds[Math.floor(this.rng() * this.deps.sounds.length)]!;
    const durationMs = Math.min(sound.durationMs, clipMs);
    if (durationMs < LIMITS.minChunkMs) return;
    const target = this.deps.room.uploadTarget(this.deps.playerId, round);
    if ('code' in target) return; // phase moved on
    const meta: ChunkMeta = {
      id: randomUUID(),
      startMs: Math.floor(this.rng() * (clipMs - durationMs + 1)),
      offsetMs: 0,
      durationMs,
      mime: sound.mime,
      bytes: sound.data.length,
    };
    await this.deps.put(round, target.submissionId, meta.id, meta.mime, sound.data);
    if (this.closed) return;
    manifest.push(meta);
    this.act({ t: 'manifest', round, chunks: [...manifest] });
  }

  private onShowcase(s: RoomSnapshot): void {
    const sc = s.showcase;
    if (!sc) return;
    const id = sc.submissionId;
    if (sc.status === 'LOADING' && !this.preloaded.has(id)) {
      this.preloaded.add(id);
      this.timers.set(`pre:${id}`, this.between(BOT.preloadDelayMs), () =>
        this.act({ t: 'preloaded', submissionId: id }),
      );
    } else if (
      sc.status === 'PLAYING' &&
      !s.you.isOwnItem &&
      s.you.vote === null &&
      !this.voted.has(id) &&
      sc.startAt !== null &&
      sc.lockAt !== null
    ) {
      this.voted.add(id);
      const now = this.deps.clock.now();
      const clipMs = sc.clip.durationMs;
      const at = sc.startAt + clipMs * this.between(BOT.voteAt);
      const delay = Math.max(0, Math.min(at, sc.lockAt - 50) - now);
      const score = this.int(BOT.score);
      this.timers.set(`vote:${id}`, delay, () =>
        this.act({ t: 'vote', submissionId: id, score }),
      );
    }
  }
}
