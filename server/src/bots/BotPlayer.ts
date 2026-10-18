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
  /** v1.2 #47: 3–6 snippets (3–8 s each), spread over the clip, some overlap allowed. */
  chunks: [3, 6],
  /** Chunk "recordings" land between `dubStartMs` and `min(dubEndFrac × time left, dubEndMs)`. */
  dubStartMs: 500,
  dubEndFrac: 0.5,
  /** v1.2 #47: bots are done within ~15 s, so a test game never waits out a long timer. */
  dubEndMs: 12_000,
  /** Each chunk's centre jitters by this fraction of its slot (clip length / chunks). */
  slotJitter: 0.6,
  doneDelayMs: [300, 1500],
  preloadDelayMs: [20, 150],
  /** Vote lands at this fraction of the clip's playback. */
  voteAt: [0.3, 0.95],
  score: [3, 9],
} as const;

/**
 * Server-side player for dev/test mode (V01). Implements `Connection`, so the room's normal
 * per-recipient snapshots arrive in `send`; it reacts by calling the Room API on a timer
 * (never synchronously: `send` runs inside a room mutation). Has no WebRTC; it "talks" in voice
 * phases through `BotVoiceScheduler` (v1.2 #47).
 */
export class BotPlayer implements Connection {
  private readonly timers: Timers;
  private readonly rng: () => number;
  private closed = false;
  private dubRound = -1;
  /** Chunk recordings not yet started this round (run early once every human is done). */
  private readonly pendingChunks = new Map<string, () => void>();
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
    this.pendingChunks.clear();
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
        } else if (this.pendingChunks.size > 0 && this.humansDone(s)) {
          this.hurry();
        }
        return;
      case 'SHOWCASE':
        this.onShowcase(s);
        return;
      default:
        return;
    }
  }

  /** Every connected human pressed Done (bots then record what is left right away). */
  private humansDone(s: RoomSnapshot): boolean {
    const humans = s.players.filter((p) => !p.isBot && p.connected);
    return humans.length > 0 && humans.every((p) => p.dubDone);
  }

  /** Re-times every pending chunk to (almost) now; asynchronous like every bot action. */
  private hurry(): void {
    const jobs = [...this.pendingChunks];
    this.pendingChunks.clear();
    for (const [key, run] of jobs) this.timers.set(key, this.between(BOT.preloadDelayMs), run);
  }

  /**
   * 3–6 snippets "recorded" over the first seconds of the phase (at most ~12 s in, sooner when
   * every human is done). Placement: the clip is split into one slot per chunk and each chunk is
   * centred in its slot with some jitter, so the dub covers the clip; long snippets may overlap.
   */
  private planDub(s: RoomSnapshot): void {
    const round = s.round;
    const clipMs = s.you.clip?.durationMs ?? 0; // V14: own clip
    const now = this.deps.clock.now();
    const left = Math.max(1000, (s.phaseEndsAt ?? now + 10_000) - now);
    const sounds = this.deps.sounds;
    this.pendingChunks.clear();
    const n = sounds.length > 0 && clipMs >= LIMITS.minChunkMs ? this.int(BOT.chunks) : 0;
    const end = Math.max(BOT.dubStartMs, Math.min(left * BOT.dubEndFrac, BOT.dubEndMs));
    const times = Array.from({ length: n }, () => this.between([BOT.dubStartMs, end])).sort(
      (a, b) => a - b,
    );
    const plan = Array.from({ length: n }, (_, i) => this.placeChunk(i, n, clipMs));
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
      const key = `chunk:${round}:${i}`;
      const run = (): void => {
        this.pendingChunks.delete(key);
        if (this.closed) return;
        void this.recordChunk(round, plan[i]!, manifest)
          .catch((e: unknown) => this.deps.onError?.(e))
          .finally(() => {
            if (--pending === 0 && !this.closed) finish();
          });
      };
      this.pendingChunks.set(key, run);
      this.timers.set(key, at, run);
    });
    if (this.humansDone(s)) this.hurry();
  }

  /** Chunk `i` of `n`: a random snippet centred (with jitter) in its slot of the clip. */
  private placeChunk(
    i: number,
    n: number,
    clipMs: number,
  ): { sound: BotSound; startMs: number; durationMs: number } {
    const sound = this.deps.sounds[Math.floor(this.rng() * this.deps.sounds.length)]!;
    const durationMs = Math.min(sound.durationMs, clipMs);
    const slot = clipMs / n;
    const centre = (i + 0.5) * slot + (this.rng() - 0.5) * slot * BOT.slotJitter;
    const startMs = Math.round(Math.min(clipMs - durationMs, Math.max(0, centre - durationMs / 2)));
    return { sound, startMs, durationMs };
  }

  private async recordChunk(
    round: number,
    chunk: { sound: BotSound; startMs: number; durationMs: number },
    manifest: ChunkMeta[],
  ): Promise<void> {
    const { sound, startMs, durationMs } = chunk;
    if (durationMs < LIMITS.minChunkMs) return;
    const target = this.deps.room.uploadTarget(this.deps.playerId, round);
    if ('code' in target) return; // phase moved on
    const meta: ChunkMeta = {
      id: randomUUID(),
      startMs,
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
      this.timers.set(`vote:${id}`, delay, () => this.act({ t: 'vote', submissionId: id, score }));
    }
  }
}
