import { describe, expect, it } from 'vitest';
import { dbToMeter, MicOkDetector, rms, SILENCE_DB, toDb } from '../src/audio/levels';
import {
  clampOffset,
  pickRecorderMime,
  Recorder,
  type MediaRecorderLike,
} from '../src/audio/recorder';

describe('pickRecorderMime', () => {
  it('prefers webm/opus (Chrome)', () => {
    expect(pickRecorderMime(() => true)).toBe('audio/webm;codecs=opus');
  });
  it('falls back to ogg/opus (older Firefox)', () => {
    expect(pickRecorderMime((m) => m === 'audio/ogg;codecs=opus')).toBe('audio/ogg;codecs=opus');
  });
  it('falls back to mp4 (Safari)', () => {
    expect(pickRecorderMime((m) => m === 'audio/mp4')).toBe('audio/mp4');
  });
  it('returns null when nothing is supported, and survives throwing checks', () => {
    expect(pickRecorderMime(() => false)).toBeNull();
    expect(
      pickRecorderMime((m) => {
        if (m.includes('webm')) throw new Error('boom');
        return m === 'audio/mp4';
      }),
    ).toBe('audio/mp4');
  });
});

describe('levels', () => {
  it('computes RMS and dBFS', () => {
    expect(rms([])).toBe(0);
    expect(rms([1, -1, 1, -1])).toBe(1);
    expect(toDb(1)).toBe(0);
    expect(toDb(0.1)).toBeCloseTo(-20);
    expect(toDb(0)).toBe(SILENCE_DB);
    expect(dbToMeter(-60)).toBe(0);
    expect(dbToMeter(0)).toBe(1);
    expect(dbToMeter(-30)).toBe(0.5);
  });
});

/** Feed a synthetic dBFS series sampled every `stepMs`. */
function feed(d: MicOkDetector, series: number[], stepMs = 50, t0 = 0): boolean[] {
  return series.map((db, i) => d.push(t0 + i * stepMs, db));
}
const rep = (db: number, n: number) => Array<number>(n).fill(db);

describe('MicOkDetector', () => {
  it('stays false on silence', () => {
    const d = new MicOkDetector();
    expect(feed(d, rep(-80, 200)).some(Boolean)).toBe(false);
  });

  it('stays false for loud bursts shorter than 120 ms', () => {
    const d = new MicOkDetector();
    // 100 ms loud (4 samples × 25 ms), then silence
    feed(d, [...rep(-30, 4), ...rep(-80, 40)], 25);
    expect(d.ok).toBe(false);
    expect(d.progress()).toBeCloseTo(100 / 120);
  });

  it('turns true after ~120 ms above -50 dBFS (#53: first window with signal)', () => {
    const d = new MicOkDetector();
    const out = feed(d, [...rep(-80, 10), ...rep(-40, 6)], 25);
    // loud from index 10 (250 ms); 120 ms counted once 5 loud samples are followed by a 6th
    expect(out.slice(0, 15).some(Boolean)).toBe(false);
    expect(out.at(-1)).toBe(true);
    // i.e. OK ~125 ms after the voice starts, not 300+ ms
    expect(15 * 25 - 250).toBeLessThanOrEqual(130);
  });

  it('counts cumulative loud time within the 5 s window (syllables)', () => {
    const d = new MicOkDetector();
    // 3 bursts of 50 ms with 450 ms pauses → 150 ms loud within 1.5 s
    const syllable = [...rep(-35, 1), ...rep(-70, 9)];
    feed(d, [...syllable, ...syllable, ...syllable, -70]);
    expect(d.ok).toBe(true);
  });

  it('forgets loud time older than 5 s', () => {
    const d = new MicOkDetector();
    // 100 ms loud, 6 s quiet, 100 ms loud → never 120 ms within one window
    feed(d, [...rep(-35, 2), ...rep(-70, 120), ...rep(-35, 2), -70]);
    expect(d.ok).toBe(false);
  });

  it('reports a dead mic after 5 s without any signal, never once ok', () => {
    const d = new MicOkDetector();
    feed(d, rep(-100, 99)); // 0 … 4.9 s of digital silence
    expect(d.dead(4900)).toBe(false);
    d.push(5000, -100);
    expect(d.dead(5000)).toBe(true);
    d.push(5050, -30); // a sound: no longer dead, then ok
    expect(d.dead(5050)).toBe(false);
    feed(d, rep(-30, 4), 50, 5100);
    expect(d.ok).toBe(true);
    feed(d, rep(-100, 200), 50, 6000);
    expect(d.dead(16_000)).toBe(false); // latched
  });

  it('treats exactly -50 dBFS as not loud', () => {
    const d = new MicOkDetector();
    feed(d, rep(-50, 40));
    expect(d.ok).toBe(false);
  });

  it('does not let a stalled timer fake a long signal', () => {
    const d = new MicOkDetector();
    d.push(0, -30);
    d.push(2000, -80); // one loud sample then a 2 s gap: counts as 60 ms max
    expect(d.ok).toBe(false);
  });

  it('latches until reset', () => {
    const d = new MicOkDetector();
    feed(d, rep(-30, 10));
    expect(d.ok).toBe(true);
    feed(d, rep(-90, 200), 50, 1000);
    expect(d.ok).toBe(true);
    d.reset();
    expect(d.ok).toBe(false);
  });
});

class FakeRecorder implements MediaRecorderLike {
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType = '';
  onstart: ((ev: Event) => void) | null = null;
  onstop: ((ev: Event) => void) | null = null;
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(readonly opts: { mimeType: string; audioBitsPerSecond: number }) {}
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['abc']) });
    this.onstop?.(new Event('stop'));
  }
}

describe('Recorder latency compensation', () => {
  function setup() {
    let t = 0;
    let fake: FakeRecorder | null = null;
    const rec = new Recorder({} as MediaStream, {
      mime: 'audio/ogg;codecs=opus',
      now: () => t,
      createRecorder: (_s, o) => (fake = new FakeRecorder(o)),
    });
    return { rec, setT: (v: number) => (t = v), fake: () => fake! };
  }

  it('starts the video on onstart and stores offset = tVid - tRec', async () => {
    const { rec, setT, fake } = setup();
    let videoStarted = false;
    const started = rec.start(async () => {
      videoStarted = true;
      return 1180; // first frame presented
    });
    expect(fake().opts).toEqual({ mimeType: 'audio/ogg;codecs=opus', audioBitsPerSecond: 48_000 });
    expect(videoStarted).toBe(false); // waits for onstart
    setT(1000);
    fake().onstart!(new Event('start'));
    expect(videoStarted).toBe(true);
    await expect(started).resolves.toEqual({ offsetMs: 180 });
    setT(4000);
    const res = await rec.stop();
    expect(res.offsetMs).toBe(180);
    expect(res.durationMs).toBe(3000 - 180);
    expect(res.mime).toBe('audio/ogg;codecs=opus');
    expect(res.blob.size).toBe(3);
  });

  it('clamps the offset to 0..1000 ms', async () => {
    expect(clampOffset(-20)).toBe(0);
    expect(clampOffset(5000)).toBe(1000);
    expect(clampOffset(Number.NaN)).toBe(0);
    const { rec, setT, fake } = setup();
    const started = rec.start(async () => 9000);
    setT(1000);
    fake().onstart!(new Event('start'));
    await expect(started).resolves.toEqual({ offsetMs: 1000 });
  });

  it('rejects and cancels when the video fails to start', async () => {
    const { rec, fake } = setup();
    const started = rec.start(() => Promise.reject(new Error('autoplay blocked')));
    fake().onstart!(new Event('start'));
    await expect(started).rejects.toThrow('autoplay blocked');
    expect(fake().state).toBe('inactive');
  });

  it('throws when no format is supported', () => {
    expect(
      () =>
        new Recorder({} as MediaStream, {
          createRecorder: () => new FakeRecorder({ mimeType: '', audioBitsPerSecond: 0 }),
        }),
    ).toThrow();
  });
});
