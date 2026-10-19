import { planSchedule } from '@dub/shared';
import {
  browserTimers,
  type AudioBufferLike,
  type AudioContextLike,
  type AudioNodeLike,
  type BufferSourceLike,
  type GainNodeLike,
  type Timers,
  type VideoLike,
} from './types';

/** A chunk the player can schedule: placement on the clip timeline plus its decoded audio. */
export interface DubChunk {
  id: string;
  startMs: number;
  offsetMs: number;
  durationMs: number;
  buffer: AudioBufferLike;
}

export type DubPlayerEvent =
  | { type: 'schedule'; reason: string; mediaMs: number; rate: number; sources: number }
  | { type: 'stop'; reason: string }
  | { type: 'resync'; driftMs: number }
  | { type: 'resyncSuppressed'; driftMs: number }
  | { type: 'videoCorrect'; driftMs: number; targetMs: number };

export interface DubPlayerOptions {
  video: VideoLike;
  ctx: AudioContextLike;
  /** Where the dub goes. Default `ctx.destination`. */
  output?: AudioNodeLike;
  /** Shift the schedule by the context's output latency so the dub is *heard* in sync. */
  compensateLatency?: boolean;
  /** Reschedule audio when it is this far from the video (ms). */
  driftThresholdMs?: number;
  /** Synced mode: seek the video when it is this far from the server timeline (ms). */
  syncThresholdMs?: number;
  watchdogMs?: number;
  /**
   * After `playing`/`seeked`, wait until `video.currentTime` actually advances before anchoring
   * the audio (the video often needs 50–150 ms to really start). Default true.
   */
  waitForMotion?: boolean;
  timers?: Timers;
  perfNow?: () => number;
  onEvent?: (e: DubPlayerEvent) => void;
}

interface Live {
  src: BufferSourceLike;
  gain: GainNodeLike;
}

/** Fade applied when a source starts mid-buffer or is cut off, to avoid clicks. */
const FADE_SEC = 0.008;
const MAX_LATENCY_SEC = 0.4;
const MOTION_WINDOW_MS = 30;
/** Wait-for-motion gives up after 400 ms of clock time *or* this many polls (8 ms apart). */
const MOTION_MAX_MS = 400;
export const MOTION_MAX_POLLS = 64;
/**
 * Drift resync budget: at most this many `drift` reschedules per window. A clock that never
 * agrees (a stalled audio device, a video that reports a frozen or coarse `currentTime`)
 * would otherwise tear down and rebuild every source a few times a second, forever.
 */
export const DRIFT_RESYNC_MAX = 4;
export const DRIFT_RESYNC_WINDOW_MS = 2000;

/**
 * The one playback engine for editor, showcase, final replay and render (§2.3).
 *
 * The `<video>` is the master clock. Whenever the video starts moving, seeks, or changes rate,
 * every source is stopped and the whole dub is rescheduled from `video.currentTime` with
 * `planSchedule`. A watchdog compares the media time implied by the audio clock with the
 * video and reschedules above `driftThresholdMs`.
 *
 * Synced mode (`syncTo`) additionally drives the video from a wall-clock start time (the
 * server's `startAt` converted to `performance.now()`), seeking it when it strays.
 */
export class DubPlayer {
  private readonly video: VideoLike;
  private readonly ctx: AudioContextLike;
  private readonly bus: GainNodeLike;
  private readonly timers: Timers;
  private readonly perfNow: () => number;
  private readonly onEvent?: (e: DubPlayerEvent) => void;
  private readonly compensateLatency: boolean;
  private readonly driftThresholdMs: number;
  private readonly syncThresholdMs: number;

  private output: AudioNodeLike;
  private chunks: DubChunk[] = [];
  private live = new Set<Live>();
  /** Media position and audio-clock time of the last schedule; null when not running. */
  private anchor: { ctxTime: number; mediaMs: number; rate: number } | null = null;
  private watchdog: unknown = null;
  private motionTimer: unknown = null;
  private settleTimers: unknown[] = [];
  private readonly waitForMotion: boolean;
  private disposed = false;
  private scheduling = false;
  private driftResyncs: number[] = [];

  // synced mode
  private syncStartPerf: number | null = null;
  private syncDurationMs = Infinity;
  private syncTimer: unknown = null;
  private lastCorrectionPerf = -Infinity;
  private seekStartedPerf: number | null = null;
  /** How long a corrective seek takes on this machine (EMA), used as seek lead. */
  private seekLagMs = 0;

  private readonly listeners: [string, () => void][];
  private readonly onCtxState = () => {
    if (this.ctx.state === 'running' && this.isVideoRunning())
      this.scheduleWhenMoving('audio-resumed');
  };

  constructor(opts: DubPlayerOptions) {
    this.video = opts.video;
    this.ctx = opts.ctx;
    this.timers = opts.timers ?? browserTimers;
    this.perfNow = opts.perfNow ?? (() => performance.now());
    this.onEvent = opts.onEvent;
    this.compensateLatency = opts.compensateLatency ?? true;
    this.driftThresholdMs = opts.driftThresholdMs ?? 60;
    this.syncThresholdMs = opts.syncThresholdMs ?? 150;
    this.waitForMotion = opts.waitForMotion ?? true;
    this.output = opts.output ?? this.ctx.destination;
    this.bus = this.ctx.createGain();
    this.bus.connect(this.output);

    this.listeners = [
      ['playing', () => this.scheduleWhenMoving('playing')],
      ['seeked', () => this.onSeeked()],
      ['ratechange', () => this.anchor && this.schedule('ratechange')],
      ['pause', () => this.stopAll('pause')],
      ['waiting', () => this.stopAll('waiting')],
      ['seeking', () => this.onSeeking()],
      ['ended', () => this.stopAll('ended')],
      ['emptied', () => this.stopAll('emptied')],
    ];
    for (const [t, fn] of this.listeners) this.video.addEventListener(t, fn);
    this.ctx.addEventListener?.('statechange', this.onCtxState);
    this.watchdog = this.timers.setInterval(() => this.tick(), opts.watchdogMs ?? 250);
    // Attached to a video that is already playing (e.g. remount): pick it up right away.
    if (this.isVideoRunning()) this.scheduleWhenMoving('attach');
  }

  // ---------- public API ----------

  /** Replace the chunk set. Reschedules immediately while playing. */
  setChunks(chunks: readonly DubChunk[]): void {
    this.chunks = chunks.slice();
    if (this.anchor) this.schedule('chunks');
  }

  getChunks(): readonly DubChunk[] {
    return this.chunks;
  }

  /** Route the dub somewhere else (e.g. a MediaStreamAudioDestinationNode for rendering). */
  setOutput(node: AudioNodeLike): void {
    this.bus.disconnect();
    this.output = node;
    this.bus.connect(node);
  }

  /** Dub volume 0..1 (gain on the whole bus). */
  setVolume(v: number): void {
    this.bus.gain.value = Math.max(0, Math.min(1, v));
  }

  /** Whether audio is currently scheduled against a moving video. */
  get running(): boolean {
    return this.anchor !== null;
  }

  /** Media time implied by the audio clock (ms), or null when not running. */
  audioMediaTimeMs(): number | null {
    const a = this.anchor;
    if (!a) return null;
    return a.mediaMs + (this.ctx.currentTime - a.ctxTime) * 1000 * a.rate;
  }

  /**
   * Synced mode: play the clip from 0 at wall time `startAtPerf` (a `performance.now()` value),
   * for at most `durationMs`. If that moment has passed, the video jumps straight to where it
   * should be. `null` leaves synced mode (and pauses).
   */
  syncTo(startAtPerf: number | null, durationMs = Infinity): void {
    this.clearSyncTimer();
    this.syncStartPerf = startAtPerf;
    this.syncDurationMs = durationMs;
    this.lastCorrectionPerf = -Infinity;
    if (startAtPerf === null) {
      this.video.pause();
      return;
    }
    const wait = startAtPerf - this.perfNow();
    if (wait > 0) {
      if (!this.video.paused) this.video.pause();
      if (this.video.currentTime !== 0) this.video.currentTime = 0;
      this.syncTimer = this.timers.setTimeout(() => {
        this.syncTimer = null;
        this.syncStart();
      }, wait);
    } else {
      this.syncStart();
    }
  }

  /** Expected media position (ms) in synced mode right now, or null. */
  syncExpectedMs(): number | null {
    return this.syncStartPerf === null ? null : this.perfNow() - this.syncStartPerf;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearSyncTimer();
    this.clearMotion();
    this.timers.clearInterval(this.watchdog);
    for (const [t, fn] of this.listeners) this.video.removeEventListener(t, fn);
    this.ctx.removeEventListener?.('statechange', this.onCtxState);
    this.stopAll('dispose');
    this.bus.disconnect();
  }

  // ---------- internals ----------

  private isVideoRunning(): boolean {
    const v = this.video;
    return !v.paused && !v.seeking && !v.ended && v.readyState >= 3;
  }

  private latencySec(): number {
    if (!this.compensateLatency) return 0;
    const l = (this.ctx.outputLatency ?? 0) + (this.ctx.baseLatency ?? 0);
    return Number.isFinite(l) ? Math.max(0, Math.min(MAX_LATENCY_SEC, l)) : 0;
  }

  private onSeeking(): void {
    this.seekStartedPerf = this.perfNow();
    this.stopAll('seeking');
  }

  private onSeeked(): void {
    if (this.seekStartedPerf !== null && this.syncStartPerf !== null) {
      const took = this.perfNow() - this.seekStartedPerf;
      this.seekLagMs = Math.max(0, Math.min(400, this.seekLagMs * 0.5 + took * 0.5));
    }
    this.seekStartedPerf = null;
    if (!this.video.paused) this.scheduleWhenMoving('seeked');
  }

  /** Schedule as soon as the video's clock is really moving (or after 400 ms / 64 polls regardless). */
  private scheduleWhenMoving(reason: string): void {
    if (!this.waitForMotion) return this.schedule(reason);
    this.stopAll(null);
    this.clearMotion();
    // Chromium's clock creeps for ~50–80 ms after a seek (a few ms, a hold, then full speed).
    // Anchoring on its first step put the audio ahead and cost one resync after every scrub,
    // so wait until the clock has run at (nearly) full rate over the last MOTION_WINDOW_MS.
    const from = this.video.currentTime;
    const since = this.perfNow();
    const samples: [number, number][] = [];
    let polls = 0;
    const poll = () => {
      this.motionTimer = null;
      const v = this.video;
      if (this.disposed || v.paused || v.seeking || v.ended) return;
      const now = this.perfNow();
      const cur = v.currentTime;
      // Bounded twice over: by the clock and by the number of polls (a clamped or frozen
      // `performance.now()` must not keep this polling forever).
      if (now - since > MOTION_MAX_MS || ++polls >= MOTION_MAX_POLLS) return this.schedule(reason);
      if (samples.length > MOTION_MAX_POLLS) samples.shift();
      if (cur !== from) {
        samples.push([now, cur]);
        const rate = v.playbackRate > 0 ? v.playbackRate : 1;
        let ref: [number, number] | undefined;
        for (const s of samples) if (now - s[0] >= MOTION_WINDOW_MS) ref = s;
        if (ref && (cur - ref[1]) * 1000 >= 0.7 * (now - ref[0]) * rate)
          return this.schedule(reason);
      }
      this.motionTimer = this.timers.setTimeout(poll, 8);
    };
    this.motionTimer = this.timers.setTimeout(poll, 8);
  }

  private clearMotion(): void {
    if (this.motionTimer !== null) this.timers.clearTimeout(this.motionTimer);
    this.motionTimer = null;
  }

  private schedule(reason: string): void {
    // Re-entrancy guard: nothing below may synchronously end up scheduling again.
    if (this.disposed || this.scheduling) return;
    this.scheduling = true;
    try {
      this.scheduleNow(reason);
    } finally {
      this.scheduling = false;
    }
  }

  private scheduleNow(reason: string): void {
    this.stopAll(null);
    this.clearMotion();
    const v = this.video;
    if (v.paused || v.ended) return;
    const rate = v.playbackRate > 0 ? v.playbackRate : 1;
    const mediaMs = v.currentTime * 1000;
    const t0 = this.ctx.currentTime;
    this.anchor = { ctxTime: t0, mediaMs, rate };
    // Audio started now is heard `latency` later, when the video is `latency*rate` further on.
    const plan = planSchedule(this.chunks, mediaMs + this.latencySec() * 1000 * rate, rate);
    const byId = new Map(this.chunks.map((c) => [c.id, c]));
    for (const p of plan) {
      const chunk = byId.get(p.chunkId);
      if (!chunk) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = chunk.buffer;
      src.playbackRate.value = rate;
      const gain = this.ctx.createGain();
      src.connect(gain);
      gain.connect(this.bus);
      const when = t0 + p.whenDelaySec;
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
    this.onEvent?.({ type: 'schedule', reason, mediaMs, rate, sources: plan.length });
    // Rate changes in particular take a moment to reach the video clock: check again soon
    // instead of waiting for the next watchdog tick.
    for (const t of this.settleTimers) this.timers.clearTimeout(t);
    this.settleTimers = [150, 400].map((ms) => this.timers.setTimeout(() => this.checkDrift(), ms));
  }

  private stopAll(reason: string | null): void {
    if (reason !== null) this.clearMotion();
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
      // Disconnect after the fade-out has run.
      this.timers.setTimeout(() => {
        src.disconnect();
        gain.disconnect();
      }, 50);
    }
    this.live.clear();
    if (reason !== null && this.anchor) this.onEvent?.({ type: 'stop', reason });
    this.anchor = null;
  }

  private tick(): void {
    if (this.disposed) return;
    this.syncTick();
    if (!this.anchor) {
      // Missed a start event (e.g. ctx resumed late): pick the video up.
      if (this.motionTimer === null && this.isVideoRunning() && this.ctx.state === 'running')
        this.scheduleWhenMoving('watchdog-start');
      return;
    }
    this.checkDrift();
  }

  private checkDrift(): void {
    if (!this.anchor || this.disposed) return;
    if (this.ctx.state !== 'running' || this.video.seeking || this.video.paused) return;
    const implied = this.audioMediaTimeMs()!;
    const drift = this.video.currentTime * 1000 - implied;
    if (Math.abs(drift) > this.driftThresholdMs) {
      const now = this.perfNow();
      this.driftResyncs = this.driftResyncs.filter((t) => now - t < DRIFT_RESYNC_WINDOW_MS);
      if (this.driftResyncs.length >= DRIFT_RESYNC_MAX) {
        this.onEvent?.({ type: 'resyncSuppressed', driftMs: drift });
        return;
      }
      this.driftResyncs.push(now);
      this.onEvent?.({ type: 'resync', driftMs: drift });
      this.schedule('drift');
    }
  }

  private syncStart(): void {
    const start = this.syncStartPerf;
    if (start === null || this.disposed) return;
    const now = this.perfNow();
    const expected = now - start;
    if (expected >= this.syncDurationMs) return;
    // Late joiner (or retry): jump to where everyone else is, plus the expected seek time.
    const targetMs = expected > 30 ? expected + this.seekLagMs : 0;
    if (Math.abs(this.video.currentTime * 1000 - targetMs) > 40) {
      this.video.currentTime = targetMs / 1000;
      this.lastCorrectionPerf = now;
    }
    this.video.playbackRate = 1;
    this.video.play().catch(() => {
      /* autoplay blocked: syncTick retries after the user unlocks */
    });
  }

  private syncTick(): void {
    const start = this.syncStartPerf;
    if (start === null || this.syncTimer !== null) return;
    const v = this.video;
    const now = this.perfNow();
    const expected = now - start;
    const end = Math.min(
      this.syncDurationMs,
      Number.isFinite(v.duration) ? v.duration * 1000 : Infinity,
    );
    if (expected >= end - 100 || v.ended) return;
    if (v.seeking) return;
    if (v.paused) {
      // Autoplay blocked or stalled out: try again, from the right place.
      this.syncStart();
      return;
    }
    if (v.readyState < 3) return;
    const drift = v.currentTime * 1000 - expected;
    if (Math.abs(drift) > this.syncThresholdMs && now - this.lastCorrectionPerf > 1000) {
      const targetMs = expected + this.seekLagMs;
      this.lastCorrectionPerf = now;
      this.onEvent?.({ type: 'videoCorrect', driftMs: drift, targetMs });
      v.currentTime = targetMs / 1000;
    }
  }

  private clearSyncTimer(): void {
    if (this.syncTimer !== null) this.timers.clearTimeout(this.syncTimer);
    this.syncTimer = null;
  }
}
