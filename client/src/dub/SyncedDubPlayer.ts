import { planSchedule } from '@dub/shared';
import type { DubChunk } from './DubPlayer';
import {
  browserTimers,
  type AudioContextLike,
  type AudioNodeLike,
  type BufferSourceLike,
  type GainNodeLike,
  type Timers,
  type VideoLike,
} from './types';

/**
 * #53 synced playback for the showcase (§2.3 synced mode), with the **audio as the reference**.
 *
 * The dub (normally one pre-mixed buffer, `premixDub`) is scheduled on the AudioContext clock so
 * that clip time 0 is heard at the server's `startAt`. The audio thread keeps that timeline even
 * when the main thread janks. The muted `<video>` follows it:
 * - 25–400 ms off: `playbackRate` is nudged between 0.95 and 1.05 until it converges (no seek,
 *   so no visible stutter and no rebuffer),
 * - more than ~400 ms off (a stall), or a late joiner: one hard seek.
 * The audio itself is only restarted (one node) if the audio clock lost time against the wall
 * clock, e.g. after the context was suspended.
 */

export type SyncedEvent =
  | { type: 'audioStart'; mediaMs: number; sources: number }
  | { type: 'audioRestart'; errMs: number }
  | { type: 'hardSeek'; driftMs: number; targetMs: number }
  | { type: 'joinSeek'; targetMs: number }
  | { type: 'rate'; rate: number; driftMs: number };

export interface SyncStats {
  /** Corrective seeks (drift > `hardSeekMs`); a late join is counted in `joinSeeks`. */
  hardSeeks: number;
  joinSeeks: number;
  audioRestarts: number;
  /** Last measured video − audio offset (ms), null when not playing. */
  driftMs: number | null;
  rate: number;
}

export interface SyncedVideo extends VideoLike {
  preservesPitch?: boolean;
}

export interface SyncedDubPlayerOptions {
  video: SyncedVideo;
  ctx: AudioContextLike;
  output?: AudioNodeLike;
  timers?: Timers;
  perfNow?: () => number;
  onEvent?: (e: SyncedEvent) => void;
  /** Control loop period (ms). */
  tickMs?: number;
  hardSeekMs?: number;
  compensateLatency?: boolean;
}

export const RATE_MIN = 0.95;
export const RATE_MAX = 1.05;
/** Below this the video counts as in sync (rate back to 1). */
export const DRIFT_OK_MS = 25;
export const HARD_SEEK_MS = 400;
/** Drift (ms) that maps to the full ±5 % rate. */
const RATE_FULL_SCALE_MS = 100;
/** Audio clock vs. wall clock disagreement that restarts the audio. */
const AUDIO_RESTART_MS = 80;
const MAX_LATENCY_SEC = 0.4;
/** Schedule a little in the future so the first samples are not cut. */
const SCHEDULE_LEAD_SEC = 0.02;
const FADE_SEC = 0.008;
/** The video needs this long (ms) to really start moving after `play()`; EMA-updated. */
const INITIAL_START_LAG_MS = 60;
const MAX_START_LAG_MS = 150;
/** Starting this much (ms) after `startAt` or later counts as a late join (one seek in). */
const LATE_START_MS = 150;
/** `syncTo` with a start this close to the current one is the same timeline. */
const SAME_START_MS = 30;
/**
 * After the main thread was blocked, `video.currentTime` is stale for a moment (Firefox mirrors
 * the media clock to the main thread asynchronously, while frames keep being presented off it):
 * no corrections for this long after a stalled tick.
 */
const STALE_AFTER_STALL_MS = 300;

interface Live {
  src: BufferSourceLike;
  gain: GainNodeLike;
}

export class SyncedDubPlayer {
  private readonly video: SyncedVideo;
  private readonly ctx: AudioContextLike;
  private readonly bus: GainNodeLike;
  private readonly timers: Timers;
  private readonly perfNow: () => number;
  private readonly onEvent?: (e: SyncedEvent) => void;
  private readonly hardSeekMs: number;
  private readonly compensateLatency: boolean;
  private chunks: DubChunk[] = [];
  private live = new Set<Live>();
  private loop: unknown;
  private startTimer: unknown = null;
  private disposed = false;

  private startPerf: number | null = null;
  private durationMs = Infinity;
  /** AudioContext time at which clip time 0 enters the graph (heard `latency` later). */
  private ctxZero: number | null = null;
  private lastSeekPerf = -Infinity;
  private seekStartPerf: number | null = null;
  private seekLagMs = 0;
  private startLagMs = INITIAL_START_LAG_MS;
  private playCalledPerf: number | null = null;
  /** The context was not running when the audio should have been scheduled. */
  private audioPending = false;
  private readonly tickMs: number;
  private lastTickPerf: number | null = null;
  private staleUntil = -Infinity;
  /** Consecutive ticks above the hard-seek threshold (a seek needs two). */
  private overTicks = 0;

  readonly stats: SyncStats = {
    hardSeeks: 0,
    joinSeeks: 0,
    audioRestarts: 0,
    driftMs: null,
    rate: 1,
  };

  private readonly listeners: [string, () => void][];
  private readonly onCtxState = () => {
    if (this.ctx.state === 'running') this.checkAudio();
  };

  constructor(opts: SyncedDubPlayerOptions) {
    this.video = opts.video;
    this.ctx = opts.ctx;
    this.timers = opts.timers ?? browserTimers;
    this.perfNow = opts.perfNow ?? (() => performance.now());
    this.onEvent = opts.onEvent;
    this.hardSeekMs = opts.hardSeekMs ?? HARD_SEEK_MS;
    this.compensateLatency = opts.compensateLatency ?? true;
    this.bus = this.ctx.createGain();
    this.bus.connect(opts.output ?? this.ctx.destination);
    this.video.preservesPitch = true; // muted anyway; no chipmunk artefacts while nudging
    this.listeners = [
      ['seeking', () => (this.seekStartPerf = this.perfNow())],
      [
        'seeked',
        () => {
          if (this.seekStartPerf === null) return;
          const took = this.perfNow() - this.seekStartPerf;
          this.seekLagMs = Math.max(0, Math.min(400, this.seekLagMs * 0.5 + took * 0.5));
          this.seekStartPerf = null;
        },
      ],
    ];
    for (const [t, fn] of this.listeners) this.video.addEventListener(t, fn);
    this.ctx.addEventListener?.('statechange', this.onCtxState);
    this.tickMs = opts.tickMs ?? 100;
    this.loop = this.timers.setInterval(() => this.tick(), this.tickMs);
  }

  /** The dub (normally one pre-mixed chunk). Rescheduled at once while playing. */
  setChunks(chunks: readonly DubChunk[]): void {
    this.chunks = chunks.slice();
    if (this.ctxZero !== null) this.scheduleAudio();
  }

  setVolume(v: number): void {
    this.bus.gain.value = Math.max(0, Math.min(1, v));
  }

  /**
   * Play the clip from 0 so that its start is heard at `startAtPerf` (a `performance.now()`
   * value), for at most `durationMs`. `null` stops (video paused, audio cut).
   */
  syncTo(startAtPerf: number | null, durationMs = Infinity): void {
    // Same timeline again (a new snapshot, a refined clock estimate): keep playing as is.
    if (
      startAtPerf !== null &&
      this.startPerf !== null &&
      Math.abs(startAtPerf - this.startPerf) < SAME_START_MS &&
      durationMs === this.durationMs
    )
      return;
    this.clearStartTimer();
    this.startPerf = startAtPerf;
    this.durationMs = durationMs;
    this.stopAudio();
    this.ctxZero = null;
    this.stats.driftMs = null;
    this.setRate(1);
    if (startAtPerf === null) {
      this.video.pause();
      return;
    }
    const now = this.perfNow();
    if (now - startAtPerf >= durationMs) return;
    this.ctxZero = this.ctx.currentTime + (startAtPerf - now) / 1000 - this.latencySec();
    this.scheduleAudio();
    const wait = startAtPerf - now - this.startLagMs;
    if (wait > 0) {
      if (!this.video.paused) this.video.pause();
      if (this.video.currentTime !== 0) this.video.currentTime = 0;
      this.startTimer = this.timers.setTimeout(() => {
        this.startTimer = null;
        // A long task may have held this timer back: start where the clip is by now.
        const late = this.perfNow() - startAtPerf;
        if (late > LATE_START_MS) this.joinAt(late);
        this.playVideo();
      }, wait);
    } else {
      const expected = now - startAtPerf;
      if (expected > LATE_START_MS) this.joinAt(expected);
      else if (this.video.currentTime !== 0) this.video.currentTime = 0;
      this.playVideo();
    }
  }

  /** Late joiner / late start: jump to where everyone is (plus the expected seek time). */
  private joinAt(expectedMs: number): void {
    const targetMs = expectedMs + this.seekLagMs;
    this.video.currentTime = targetMs / 1000;
    this.lastSeekPerf = this.perfNow();
    this.playCalledPerf = null;
    this.stats.joinSeeks++;
    this.onEvent?.({ type: 'joinSeek', targetMs });
  }

  /**
   * Clip time (ms) as heard right now: from the audio clock while the dub plays, else from the
   * wall clock. Null outside synced playback.
   */
  referenceMs(): number | null {
    if (this.startPerf === null) return null;
    if (this.ctxZero !== null && this.ctx.state === 'running')
      return (this.ctx.currentTime - this.ctxZero - this.latencySec()) * 1000;
    return this.perfNow() - this.startPerf;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearStartTimer();
    this.timers.clearInterval(this.loop);
    for (const [t, fn] of this.listeners) this.video.removeEventListener(t, fn);
    this.ctx.removeEventListener?.('statechange', this.onCtxState);
    this.stopAudio();
    this.bus.disconnect();
  }

  // ---------- internals ----------

  private latencySec(): number {
    if (!this.compensateLatency) return 0;
    const l = (this.ctx.outputLatency ?? 0) + (this.ctx.baseLatency ?? 0);
    return Number.isFinite(l) ? Math.max(0, Math.min(MAX_LATENCY_SEC, l)) : 0;
  }

  private playVideo(): void {
    if (this.disposed || this.startPerf === null) return;
    if (this.video.currentTime === 0) this.playCalledPerf = this.perfNow();
    this.video.play().catch(() => {
      /* autoplay blocked: the loop retries */
    });
  }

  /** (Re)starts the dub sources from the current audio position on the `ctxZero` timeline. */
  private scheduleAudio(): void {
    this.stopAudio();
    const zero = this.ctxZero;
    this.audioPending = zero !== null && this.ctx.state !== 'running';
    if (zero === null || this.ctx.state !== 'running' || this.chunks.length === 0) return;
    const at = Math.max(this.ctx.currentTime + SCHEDULE_LEAD_SEC, zero);
    const mediaMs = (at - zero) * 1000;
    if (mediaMs >= this.durationMs) return;
    const byId = new Map(this.chunks.map((c) => [c.id, c]));
    const plan = planSchedule(this.chunks, mediaMs, 1);
    for (const p of plan) {
      const chunk = byId.get(p.chunkId);
      if (!chunk) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = chunk.buffer;
      const gain = this.ctx.createGain();
      src.connect(gain);
      gain.connect(this.bus);
      const when = at + p.whenDelaySec;
      if (p.whenDelaySec === 0 && p.bufferOffsetSec * 1000 > chunk.offsetMs + 1) {
        gain.gain.setValueAtTime(0, when);
        gain.gain.linearRampToValueAtTime(1, when + FADE_SEC);
      }
      const entry: Live = { src, gain };
      src.onended = () => {
        if (!this.live.delete(entry)) return;
        src.disconnect();
        gain.disconnect();
      };
      src.start(when, p.bufferOffsetSec, p.durationSec);
      this.live.add(entry);
    }
    this.onEvent?.({ type: 'audioStart', mediaMs, sources: plan.length });
  }

  private stopAudio(): void {
    const now = this.ctx.currentTime;
    for (const { src, gain } of this.live) {
      src.onended = null;
      try {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + FADE_SEC);
        src.stop(now + FADE_SEC);
      } catch {
        /* already stopped */
      }
      this.timers.setTimeout(() => {
        src.disconnect();
        gain.disconnect();
      }, 50);
    }
    this.live.clear();
  }

  /** The audio clock must agree with the wall clock; if not (suspended context), restart. */
  private checkAudio(): void {
    const start = this.startPerf;
    if (start === null || this.ctxZero === null || this.ctx.state !== 'running') return;
    const wallMs = this.perfNow() - start;
    if (wallMs >= this.durationMs) return;
    const audioMs = (this.ctx.currentTime - this.ctxZero - this.latencySec()) * 1000;
    const err = audioMs - wallMs;
    if (Math.abs(err) > AUDIO_RESTART_MS || this.audioPending) {
      this.ctxZero = this.ctx.currentTime - wallMs / 1000 - this.latencySec();
      if (!this.audioPending) {
        this.stats.audioRestarts++;
        this.onEvent?.({ type: 'audioRestart', errMs: err });
      }
      this.scheduleAudio();
    }
  }

  private setRate(rate: number): void {
    if (Math.abs(this.video.playbackRate - rate) < 0.004 && this.stats.rate === rate) return;
    this.video.playbackRate = rate;
    this.stats.rate = rate;
  }

  private tick(): void {
    const tickAt = this.perfNow();
    const last = this.lastTickPerf;
    this.lastTickPerf = tickAt;
    if (last !== null && tickAt - last > this.tickMs * 2.5) {
      this.staleUntil = tickAt + STALE_AFTER_STALL_MS;
      this.overTicks = 0;
    }
    if (this.disposed || this.startPerf === null || this.startTimer !== null) return;
    this.checkAudio();
    const v = this.video;
    const ref = this.referenceMs();
    if (ref === null) return;
    const end = Math.min(
      this.durationMs,
      Number.isFinite(v.duration) ? v.duration * 1000 : Infinity,
    );
    if (ref >= end - 100 || v.ended) {
      this.setRate(1);
      this.stats.driftMs = null;
      return;
    }
    if (v.paused) {
      this.playVideo();
      return;
    }
    if (v.seeking || v.readyState < 2) return;
    const now = this.perfNow();
    if (now < this.staleUntil) return; // main thread just stalled: readings are stale
    // How long the video really takes to start moving after play() (it is started that early).
    if (this.playCalledPerf !== null && v.currentTime > 0.05) {
      const lag = now - this.playCalledPerf - v.currentTime * 1000;
      this.startLagMs = Math.max(0, Math.min(MAX_START_LAG_MS, this.startLagMs * 0.5 + lag * 0.5));
      this.playCalledPerf = null;
    }
    const drift = v.currentTime * 1000 - ref;
    this.stats.driftMs = drift;
    this.overTicks = Math.abs(drift) > this.hardSeekMs ? this.overTicks + 1 : 0;
    if (this.overTicks >= 2 && now - this.lastSeekPerf > 1000) {
      this.overTicks = 0;
      const targetMs = ref + this.seekLagMs;
      this.lastSeekPerf = now;
      this.stats.hardSeeks++;
      this.setRate(1);
      this.onEvent?.({ type: 'hardSeek', driftMs: drift, targetMs });
      v.currentTime = targetMs / 1000;
      return;
    }
    let rate = 1;
    if (Math.abs(drift) > DRIFT_OK_MS) {
      const k = Math.max(-1, Math.min(1, drift / RATE_FULL_SCALE_MS));
      rate = Math.round((1 - k * (RATE_MAX - 1)) * 1000) / 1000;
      rate = Math.max(RATE_MIN, Math.min(RATE_MAX, rate));
    }
    if (rate !== this.stats.rate) this.onEvent?.({ type: 'rate', rate, driftMs: drift });
    this.setRate(rate);
  }

  private clearStartTimer(): void {
    if (this.startTimer !== null) this.timers.clearTimeout(this.startTimer);
    this.startTimer = null;
  }
}
