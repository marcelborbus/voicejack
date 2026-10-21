import { beforeEach, describe, expect, it } from 'vitest';
import type { DubChunk } from '../src/dub/DubPlayer';
import {
  HARD_SEEK_MS,
  RATE_MAX,
  RATE_MIN,
  SyncedDubPlayer,
  type SyncedEvent,
} from '../src/dub/SyncedDubPlayer';
import { MIX_ID, planMix, premixDub, type OfflineCtxLike } from '../src/dub/premix';
import { acquireClip, clipCacheSize, prefetchClip, setClipCacheDeps } from '../src/dub/clipCache';
import { buffer, FakeCtx, FakeTimers, FakeVideo } from './dubFakes';

const MIX: DubChunk[] = [
  { id: MIX_ID, startMs: 0, offsetMs: 0, durationMs: 12_000, buffer: buffer(12) },
];

describe('SyncedDubPlayer (#53: audio is the reference, the video follows)', () => {
  let ctx: FakeCtx;
  let video: FakeVideo;
  let timers: FakeTimers;
  let player: SyncedDubPlayer;
  let events: SyncedEvent[];
  /** Advance wall clock, audio clock and (if playing) the video at `video.playbackRate`. */
  let step: (dt: number) => void;

  beforeEach(() => {
    ctx = new FakeCtx();
    video = new FakeVideo();
    video.muted = true;
    timers = new FakeTimers();
    timers.now = 10_000;
    events = [];
    player = new SyncedDubPlayer({
      video,
      ctx,
      timers,
      perfNow: () => timers.now,
      onEvent: (e) => events.push(e),
    });
    player.setChunks(MIX);
    step = (dt) => {
      ctx.currentTime += dt / 1000;
      if (!video.paused) video.currentTime += (dt / 1000) * video.playbackRate;
    };
  });

  const seeks = () => events.filter((e) => e.type === 'hardSeek').length;

  it('schedules the one mixed source on the audio clock at startAt, starts the video just before', () => {
    player.syncTo(11_000, 12_000);
    const [src] = ctx.take();
    expect(src!.started!.when).toBeCloseTo(101, 6); // ctx 100 now, start in 1 s
    expect(src!.started!.offset).toBe(0);
    expect(video.playCalls).toBe(0);
    timers.advance(1000, step);
    expect(video.playCalls).toBe(1);
    expect((video as { preservesPitch?: boolean }).preservesPitch).toBe(true);
  });

  it('nudges playbackRate within 0.95–1.05 for small drift and converges without seeking', () => {
    player.syncTo(10_000, 12_000);
    timers.advance(1000, step);
    video.currentTime -= 0.2; // 200 ms behind (a dropped burst)
    const rates: number[] = [];
    for (let i = 0; i < 80; i++) {
      timers.advance(100, step);
      rates.push(video.playbackRate);
    }
    expect(Math.max(...rates)).toBeLessThanOrEqual(RATE_MAX);
    expect(Math.min(...rates)).toBeGreaterThanOrEqual(RATE_MIN);
    expect(rates[0]).toBeGreaterThan(1);
    expect(seeks()).toBe(0);
    expect(Math.abs(player.stats.driftMs!)).toBeLessThan(30);
    expect(video.playbackRate).toBe(1);
  });

  it('hard-seeks once when the video is more than 400 ms off', () => {
    player.syncTo(10_000, 12_000);
    timers.advance(1000, step);
    video.currentTime -= (HARD_SEEK_MS + 200) / 1000;
    timers.advance(300, step);
    expect(seeks()).toBe(1);
    expect(Math.abs(video.currentTime * 1000 - (timers.now - 10_000))).toBeLessThan(50);
  });

  it('a 500 ms main-thread stall (no timers) does not cause a seek: both clocks kept running', () => {
    player.syncTo(10_000, 12_000);
    timers.advance(2000, step);
    // Long task: neither timers nor the loop run; audio and video advance on their own threads.
    const at = timers.now;
    step(500);
    timers.now = at + 500;
    timers.advance(300, step);
    expect(seeks()).toBe(0);
    expect(Math.abs(player.stats.driftMs!)).toBeLessThan(30);
  });

  it('a late joiner seeks straight in (counted as a join, not a correction) and hears from there', () => {
    player.syncTo(7_000, 12_000);
    expect(player.stats.joinSeeks).toBe(1);
    expect(player.stats.hardSeeks).toBe(0);
    expect(video.currentTime).toBeCloseTo(3, 2);
    const [src] = ctx.take();
    expect(src!.started!.offset).toBeCloseTo(3.02, 2);
  });

  it('restarts just the one node when the audio clock lost time (suspended context)', () => {
    player.syncTo(10_000, 12_000);
    timers.advance(1000, step);
    ctx.take();
    ctx.state = 'suspended';
    // audio frozen, wall clock and video move on
    timers.advance(500, (dt) => void (video.currentTime += dt / 1000));
    ctx.state = 'running';
    timers.advance(100, step);
    expect(player.stats.audioRestarts).toBe(1);
    const started = ctx.take();
    expect(started).toHaveLength(1);
    expect(started[0]!.started!.offset).toBeCloseTo(1.62, 1);
  });

  it('syncTo with the same start again (a new snapshot) changes nothing: no restart, no seek', () => {
    player.syncTo(10_000, 12_000);
    timers.advance(2000, step);
    ctx.take();
    player.syncTo(10_010, 12_000); // refined clock estimate
    expect(ctx.take()).toHaveLength(0);
    expect(player.stats.joinSeeks).toBe(0);
  });

  it('syncTo(null) pauses and cuts the audio', () => {
    player.syncTo(10_000, 12_000);
    const [src] = ctx.take();
    player.syncTo(null);
    expect(video.paused).toBe(true);
    expect(src!.stoppedAt).not.toBeNull();
  });
});

describe('premixDub (#53: one buffer per dub)', () => {
  const chunks: DubChunk[] = [
    { id: 'a', startMs: 1000, offsetMs: 200, durationMs: 3000, buffer: buffer(3.2) },
    { id: 'b', startMs: 2500, offsetMs: 0, durationMs: 2000, tailMs: 500, buffer: buffer(2.5) },
  ];

  it('places every chunk on the clip timeline (from 0)', () => {
    const { parts, lengthSec } = planMix(chunks);
    expect(parts.map((p) => [p.chunk.id, p.at, p.offset, p.duration])).toEqual([
      ['a', 1, 0.2, 3],
      ['b', 2.5, 0, 2.5],
    ]);
    expect(lengthSec).toBe(5);
  });

  it('renders them into one chunk at 0 with an offline context', async () => {
    const starts: number[][] = [];
    let made: [number, number, number] | null = null;
    const factory = (ch: number, len: number, sr: number): OfflineCtxLike => {
      made = [ch, len, sr];
      return {
        destination: {},
        createBufferSource: () => ({
          buffer: null,
          connect: () => undefined,
          start: (w = 0, o = 0, d = 0) => void starts.push([w, o, d]),
        }),
        startRendering: async () => buffer(len / sr, sr),
      };
    };
    const out = await premixDub(chunks, { sampleRate: 1000, factory });
    expect(made).toEqual([1, 5000, 1000]);
    expect(starts).toEqual([
      [1, 0.2, 3],
      [2.5, 0, 2.5],
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: MIX_ID, startMs: 0, offsetMs: 0, durationMs: 5000 });
    expect(await premixDub([], { sampleRate: 1000, factory })).toEqual([]);
  });
});

describe('clipCache (#53: clips play from memory)', () => {
  let fetched: string[];
  let revoked: string[];
  beforeEach(() => {
    fetched = [];
    revoked = [];
    let n = 0;
    setClipCacheDeps({
      fetch: async (url) => {
        fetched.push(url);
        if (url.includes('bad')) throw new Error('404');
        return new Blob([url]);
      },
      createObjectURL: () => `blob:${++n}`,
      revokeObjectURL: (u) => void revoked.push(u),
    });
  });

  it('fetches once (prefetch + acquire share it) and hands out the object URL', async () => {
    prefetchClip('/clips/a.mp4');
    const a = acquireClip('/clips/a.mp4');
    expect(await a.src).toBe('blob:1');
    expect(fetched).toEqual(['/clips/a.mp4']);
  });

  it('falls back to streaming the URL when the download fails', async () => {
    expect(await acquireClip('/clips/bad.mp4').src).toBe('/clips/bad.mp4');
  });

  it('keeps pinned clips and releases the oldest unpinned ones beyond four', async () => {
    const pinned = acquireClip('/c/0.mp4');
    expect(await pinned.src).toBe('blob:1');
    for (let i = 1; i <= 6; i++) {
      const c = acquireClip(`/c/${i}.mp4`);
      await c.src;
      c.release();
    }
    expect(clipCacheSize()).toBe(4);
    expect(revoked).not.toContain('blob:1'); // still pinned by a video
    expect(revoked).toEqual(['blob:2', 'blob:3', 'blob:4']);
  });
});
