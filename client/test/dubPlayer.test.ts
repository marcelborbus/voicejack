import { planSchedule } from '@dub/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { computePeaks } from '../src/dub/chunkLoader';
import {
  DRIFT_RESYNC_MAX,
  DRIFT_RESYNC_WINDOW_MS,
  DubPlayer,
  MOTION_MAX_POLLS,
  type DubChunk,
  type DubPlayerEvent,
} from '../src/dub/DubPlayer';
import type {
  AudioBufferLike,
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
  BufferSourceLike,
  GainNodeLike,
  Timers,
  VideoLike,
} from '../src/dub/types';

// ---------- fakes ----------

class FakeParam implements AudioParamLike {
  value = 1;
  setValueAtTime(v: number) {
    this.value = v;
  }
  linearRampToValueAtTime() {}
  cancelScheduledValues() {}
}

class FakeNode implements AudioNodeLike {
  connected: AudioNodeLike[] = [];
  connect(d: AudioNodeLike) {
    this.connected.push(d);
  }
  disconnect() {
    this.connected = [];
  }
}

class FakeGain extends FakeNode implements GainNodeLike {
  gain = new FakeParam();
}

interface StartCall {
  when: number;
  offset: number;
  duration: number;
}

class FakeSource extends FakeNode implements BufferSourceLike {
  buffer: AudioBufferLike | null = null;
  playbackRate = { value: 1 };
  onended: ((ev: Event) => void) | null = null;
  started: StartCall | null = null;
  stoppedAt: number | null = null;
  start(when = 0, offset = 0, duration = 0) {
    this.started = { when, offset, duration };
  }
  stop(when = 0) {
    this.stoppedAt = when;
  }
}

class FakeCtx implements AudioContextLike {
  currentTime = 100;
  state = 'running';
  destination = new FakeNode();
  outputLatency = 0;
  baseLatency = 0;
  sources: FakeSource[] = [];
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createGain() {
    return new FakeGain();
  }
  /** Sources started since the last call. */
  take(): FakeSource[] {
    const s = this.sources;
    this.sources = [];
    return s;
  }
}

class FakeVideo implements VideoLike {
  currentTime = 0;
  playbackRate = 1;
  muted = false;
  volume = 1;
  paused = true;
  seeking = false;
  ended = false;
  duration = 30;
  readyState = 4;
  private l = new Map<string, Set<() => void>>();
  playCalls = 0;
  addEventListener(t: string, fn: () => void) {
    if (!this.l.has(t)) this.l.set(t, new Set());
    this.l.get(t)!.add(fn);
  }
  removeEventListener(t: string, fn: () => void) {
    this.l.get(t)?.delete(fn);
  }
  emit(t: string) {
    for (const fn of this.l.get(t) ?? []) fn();
  }
  listenerCount() {
    let n = 0;
    for (const s of this.l.values()) n += s.size;
    return n;
  }
  play() {
    this.playCalls++;
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  // helpers mirroring browser event order
  startPlaying() {
    this.paused = false;
    this.emit('play');
    this.emit('playing');
  }
  seek(sec: number) {
    this.seeking = true;
    this.currentTime = sec;
    this.emit('seeking');
    this.seeking = false;
    this.emit('seeked');
  }
  setRate(r: number) {
    this.playbackRate = r;
    this.emit('ratechange');
  }
  doPause() {
    this.paused = true;
    this.emit('pause');
  }
}

class FakeTimers implements Timers {
  now = 0;
  private id = 0;
  private items = new Map<number, { at: number; fn: () => void; every?: number }>();
  setInterval(fn: () => void, ms: number) {
    this.items.set(++this.id, { at: this.now + ms, fn, every: ms });
    return this.id;
  }
  setTimeout(fn: () => void, ms: number) {
    this.items.set(++this.id, { at: this.now + ms, fn });
    return this.id;
  }
  clearInterval(id: unknown) {
    this.items.delete(id as number);
  }
  clearTimeout(id: unknown) {
    this.items.delete(id as number);
  }
  advance(ms: number, onStep?: (dt: number) => void) {
    const end = this.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void; every?: number }] | null = null;
      for (const e of this.items) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      const [id, item] = next;
      onStep?.(item.at - this.now);
      this.now = item.at;
      if (item.every) item.at += item.every;
      else this.items.delete(id);
      item.fn();
    }
    onStep?.(end - this.now);
    this.now = end;
  }
}

function buffer(seconds: number, sampleRate = 1000): AudioBufferLike {
  const length = Math.round(seconds * sampleRate);
  const data = new Float32Array(length);
  return {
    duration: seconds,
    length,
    sampleRate,
    numberOfChannels: 1,
    getChannelData: () => data,
  };
}

const CHUNKS: DubChunk[] = [
  { id: 'a', startMs: 1000, offsetMs: 200, durationMs: 3000, buffer: buffer(3.2) },
  { id: 'b', startMs: 2500, offsetMs: 0, durationMs: 2000, buffer: buffer(2) },
  { id: 'c', startMs: 8000, offsetMs: 50, durationMs: 1000, buffer: buffer(1.05) },
];

function expectMatchesPlan(ctx: FakeCtx, mediaMs: number, rate: number, t0: number) {
  const started = ctx.take().filter((s) => s.started);
  const plan = planSchedule(CHUNKS, mediaMs, rate);
  expect(started).toHaveLength(plan.length);
  plan.forEach((p, i) => {
    const s = started[i]!;
    const chunk = CHUNKS.find((c) => c.id === p.chunkId)!;
    expect(s.buffer).toBe(chunk.buffer);
    expect(s.playbackRate.value).toBe(rate);
    expect(s.started!.when).toBeCloseTo(t0 + p.whenDelaySec, 9);
    expect(s.started!.offset).toBeCloseTo(p.bufferOffsetSec, 9);
    expect(s.started!.duration).toBeCloseTo(p.durationSec, 9);
  });
  return started;
}

// ---------- tests ----------

describe('DubPlayer wait-for-motion', () => {
  it('anchors only once the video clock runs at full rate (Chromium post-seek creep)', () => {
    const ctx = new FakeCtx();
    const video = new FakeVideo();
    const timers = new FakeTimers();
    const events: DubPlayerEvent[] = [];
    const player = new DubPlayer({
      video,
      ctx,
      timers,
      perfNow: () => timers.now,
      onEvent: (e) => events.push(e),
    });
    player.setChunks(CHUNKS);
    video.currentTime = 0.9;
    video.startPlaying();
    // Trace from headless Chromium: +3 ms, +3 ms, +7 ms, then held for ~50 ms, then 1:1.
    const trace: [number, number][] = [
      [13, 0.903],
      [24, 0.906],
      [34, 0.913],
      [85, 0.922],
    ];
    for (const [t, c] of trace) {
      timers.advance(t - timers.now);
      video.currentTime = c;
    }
    expect(events.filter((e) => e.type === 'schedule')).toHaveLength(0);
    // from here the clock runs at full speed
    for (let i = 0; i < 10; i++) {
      timers.advance(8);
      ctx.currentTime += 0.008;
      video.currentTime += 0.008;
    }
    const sched = events.filter((e) => e.type === 'schedule');
    expect(sched).toHaveLength(1);
    expect((sched[0] as { mediaMs: number }).mediaMs).toBeGreaterThan(922);
    player.dispose();
  });

  it('still anchors after 400 ms if the clock never looks steady', () => {
    const ctx = new FakeCtx();
    const video = new FakeVideo();
    const timers = new FakeTimers();
    const events: DubPlayerEvent[] = [];
    const player = new DubPlayer({
      video,
      ctx,
      timers,
      perfNow: () => timers.now,
      onEvent: (e) => events.push(e),
    });
    video.startPlaying();
    timers.advance(390);
    expect(events.filter((e) => e.type === 'schedule')).toHaveLength(0);
    timers.advance(30);
    expect(events.filter((e) => e.type === 'schedule')).toHaveLength(1);
    player.dispose();
  });
});

describe('DubPlayer loop guards (#49)', () => {
  it('wait-for-motion stops polling after MOTION_MAX_POLLS even if performance.now() is frozen', () => {
    const ctx = new FakeCtx();
    const video = new FakeVideo();
    const timers = new FakeTimers();
    const events: DubPlayerEvent[] = [];
    let polls = 0;
    const counting: Timers = {
      ...timers,
      setTimeout: (fn, ms) => {
        if (ms === 8) polls++;
        return timers.setTimeout(fn, ms);
      },
      setInterval: (fn, ms) => timers.setInterval(fn, ms),
      clearTimeout: (id) => timers.clearTimeout(id),
      clearInterval: (id) => timers.clearInterval(id),
    };
    const player = new DubPlayer({
      video,
      ctx,
      timers: counting,
      perfNow: () => 0, // a clamped / frozen clock: "400 ms" never passes
      onEvent: (e) => events.push(e),
    });
    video.startPlaying(); // and the video clock never moves either
    timers.advance(MOTION_MAX_POLLS * 8 + 50);
    expect(events.filter((e) => e.type === 'schedule')).toHaveLength(1);
    const after = polls;
    timers.advance(5000);
    // No poll chain left running (the watchdog only re-arms motion when not anchored).
    expect(polls).toBe(after);
    expect(after).toBeLessThanOrEqual(MOTION_MAX_POLLS + 1);
    player.dispose();
  });

  it('rate-limits drift resyncs when the audio clock stalls (no reschedule storm)', () => {
    const ctx = new FakeCtx();
    const video = new FakeVideo();
    const timers = new FakeTimers();
    const events: DubPlayerEvent[] = [];
    const player = new DubPlayer({
      video,
      ctx,
      timers,
      perfNow: () => timers.now,
      waitForMotion: false,
      onEvent: (e) => events.push(e),
    });
    player.setChunks(CHUNKS);
    video.startPlaying();
    // The output device stalls: ctx.currentTime stays put while the video runs on.
    const secs = 10;
    timers.advance(secs * 1000, (dt) => {
      video.currentTime += dt / 1000;
    });
    const resyncs = events.filter((e) => e.type === 'resync').length;
    expect(resyncs).toBeGreaterThan(0);
    expect(resyncs).toBeLessThanOrEqual(
      DRIFT_RESYNC_MAX * Math.ceil((secs * 1000) / DRIFT_RESYNC_WINDOW_MS),
    );
    expect(events.some((e) => e.type === 'resyncSuppressed')).toBe(true);
    player.dispose();
  });
});

describe('DubPlayer (editor mode)', () => {
  let ctx: FakeCtx;
  let video: FakeVideo;
  let timers: FakeTimers;
  let events: DubPlayerEvent[];
  let player: DubPlayer;

  beforeEach(() => {
    ctx = new FakeCtx();
    video = new FakeVideo();
    timers = new FakeTimers();
    events = [];
    player = new DubPlayer({
      video,
      ctx,
      timers,
      perfNow: () => timers.now,
      waitForMotion: false,
      onEvent: (e) => events.push(e),
    });
    player.setChunks(CHUNKS);
  });

  it('schedules nothing while paused', () => {
    expect(ctx.take()).toHaveLength(0);
    expect(player.running).toBe(false);
  });

  it('matches planSchedule on play from 0', () => {
    video.startPlaying();
    expectMatchesPlan(ctx, 0, 1, 100);
    expect(player.running).toBe(true);
  });

  it('reschedules mid-chunk after a seek, stopping the old sources', () => {
    video.startPlaying();
    const first = ctx.take();
    ctx.currentTime = 101;
    video.seek(2.0);
    for (const s of first) expect(s.stoppedAt).not.toBeNull();
    const started = expectMatchesPlan(ctx, 2000, 1, 101);
    // chunk a is in progress: starts now, 1000 ms in + its 200 ms offset
    expect(started[0]!.started).toEqual({ when: 101, offset: 1.2, duration: 2 });
  });

  it('reschedules at the new rate on ratechange (2×)', () => {
    video.currentTime = 2.0;
    video.startPlaying();
    ctx.take();
    ctx.currentTime = 102;
    video.currentTime = 3.0;
    video.setRate(2);
    const started = expectMatchesPlan(ctx, 3000, 2, 102);
    expect(started.every((s) => s.playbackRate.value === 2)).toBe(true);
  });

  it('stops everything on pause, waiting and seeking and does not restart while paused', () => {
    video.startPlaying();
    const srcs = ctx.take();
    video.doPause();
    expect(srcs.every((s) => s.stoppedAt !== null)).toBe(true);
    expect(player.running).toBe(false);
    video.seek(5); // paused seek: no schedule
    expect(ctx.take()).toHaveLength(0);
    video.startPlaying();
    expectMatchesPlan(ctx, 5000, 1, 100);
    video.emit('waiting');
    expect(player.running).toBe(false);
  });

  it('ignores ratechange while paused', () => {
    video.setRate(1.5);
    expect(ctx.take()).toHaveLength(0);
  });

  it('reschedules when chunks change while playing', () => {
    video.startPlaying();
    ctx.take();
    player.setChunks(CHUNKS.slice(0, 1));
    expect(ctx.take().filter((s) => s.started)).toHaveLength(1);
  });

  it('compensates output latency (schedules later media now)', () => {
    ctx.outputLatency = 0.04;
    ctx.baseLatency = 0.01;
    video.currentTime = 2.0;
    video.startPlaying();
    const started = ctx.take();
    const plan = planSchedule(CHUNKS, 2050, 1);
    expect(started[0]!.started!.offset).toBeCloseTo(plan[0]!.bufferOffsetSec, 9);
  });

  it('watchdog resyncs on drift > 60 ms but not on small drift', () => {
    video.startPlaying();
    ctx.take();
    // advance both clocks together: no resync
    timers.advance(1000, (dt) => {
      ctx.currentTime += dt / 1000;
      video.currentTime += dt / 1000;
    });
    expect(events.filter((e) => e.type === 'resync')).toHaveLength(0);
    // the video jumps ahead by 100 ms (e.g. a dropped buffer): resync on the next tick
    video.currentTime += 0.1;
    timers.advance(250, (dt) => {
      ctx.currentTime += dt / 1000;
      video.currentTime += dt / 1000;
    });
    const resyncs = events.filter((e) => e.type === 'resync');
    expect(resyncs).toHaveLength(1);
    expect((resyncs[0] as { driftMs: number }).driftMs).toBeCloseTo(100, 0);
    expectMatchesPlan(ctx, video.currentTime * 1000, 1, ctx.currentTime);
  });

  it('routes output and disposes cleanly', () => {
    const dest = new FakeNode();
    player.setOutput(dest);
    video.startPlaying();
    const srcs = ctx.take();
    player.dispose();
    expect(srcs.every((s) => s.stoppedAt !== null)).toBe(true);
    expect(video.listenerCount()).toBe(0);
    video.startPlaying();
    expect(ctx.take()).toHaveLength(0);
  });
});

describe('DubPlayer (synced mode)', () => {
  let ctx: FakeCtx;
  let video: FakeVideo;
  let timers: FakeTimers;
  let player: DubPlayer;
  let events: DubPlayerEvent[];

  beforeEach(() => {
    ctx = new FakeCtx();
    video = new FakeVideo();
    video.muted = true;
    timers = new FakeTimers();
    timers.now = 10_000;
    events = [];
    player = new DubPlayer({
      video,
      ctx,
      timers,
      perfNow: () => timers.now,
      waitForMotion: false,
      onEvent: (e) => events.push(e),
    });
    player.setChunks(CHUNKS);
  });

  it('starts the video from 0 at startAt', () => {
    video.currentTime = 4;
    player.syncTo(11_500, 12_000);
    expect(video.currentTime).toBe(0);
    expect(video.playCalls).toBe(0);
    timers.advance(1499);
    expect(video.playCalls).toBe(0);
    timers.advance(1);
    expect(video.playCalls).toBe(1);
    expect(video.currentTime).toBe(0);
  });

  it('a late joiner seeks straight to the expected position', () => {
    player.syncTo(7_000, 12_000);
    expect(video.currentTime).toBeCloseTo(3, 3);
    expect(video.playCalls).toBe(1);
  });

  it('seeks the video when it strays more than 150 ms', () => {
    player.syncTo(10_000, 12_000);
    video.emit('playing');
    const step = (dt: number) => {
      ctx.currentTime += dt / 1000;
      video.currentTime += dt / 1000;
    };
    timers.advance(1000, step);
    expect(events.filter((e) => e.type === 'videoCorrect')).toHaveLength(0);
    video.currentTime -= 0.3; // stalled 300 ms
    timers.advance(250, step);
    const fixes = events.filter((e) => e.type === 'videoCorrect');
    expect(fixes).toHaveLength(1);
    expect(video.currentTime * 1000).toBeCloseTo(timers.now - 10_000, -1);
  });

  it('does nothing after the clip duration', () => {
    player.syncTo(0, 5_000);
    expect(video.playCalls).toBe(0);
  });
});

describe('computePeaks', () => {
  it('takes the max |sample| per bucket over channels', () => {
    const a = new Float32Array([0.1, -0.5, 0.2, 0.0, 0.3, -0.1]);
    const b = new Float32Array([0.0, 0.0, -0.9, 0.0, 0.0, 0.0]);
    const peaks = computePeaks(
      { length: 6, sampleRate: 200, numberOfChannels: 2, getChannelData: (c) => (c ? b : a) },
      100,
    );
    expect(Array.from(peaks).map((x) => Math.round(x * 10) / 10)).toEqual([0.5, 0.9, 0.3]);
  });
});

describe('DubPlayer effect tails (#48)', () => {
  it('schedules the tail past durationMs and lets it ring out at the clip end', () => {
    const ctx = new FakeCtx();
    const video = new FakeVideo();
    const timers = new FakeTimers();
    const player = new DubPlayer({
      video,
      ctx,
      timers,
      perfNow: () => timers.now,
      waitForMotion: false,
    });
    player.setChunks([
      { id: 'x', startMs: 1000, offsetMs: 0, durationMs: 2000, tailMs: 1500, buffer: buffer(3.5) },
    ]);
    video.startPlaying();
    const [s] = ctx.take().filter((x) => x.started);
    expect(s!.started).toEqual({ when: 101, offset: 0, duration: 3.5 });
    video.ended = true;
    video.paused = true;
    video.emit('ended');
    expect(s!.stoppedAt).toBeNull(); // not cut
    expect(player.running).toBe(false);
    // A pause, by contrast, does cut.
    video.ended = false;
    video.startPlaying();
    const [s2] = ctx.take().filter((x) => x.started);
    video.doPause();
    expect(s2!.stoppedAt).not.toBeNull();
    player.dispose();
  });
});
