import { AUDIO_MIMES, MAX_OFFSET_MS, type AudioMime } from '@dub/shared';

export const RECORDER_BITRATE = 48_000;

/** First supported mime from the fixed list (§2.3), or null if MediaRecorder can't do any. */
export function pickRecorderMime(
  isTypeSupported: (mime: string) => boolean = (m) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m),
): AudioMime | null {
  for (const m of AUDIO_MIMES) {
    try {
      if (isTypeSupported(m)) return m;
    } catch {
      /* some browsers throw on unknown types */
    }
  }
  return null;
}

export function clampOffset(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.min(MAX_OFFSET_MS, Math.max(0, ms));
}

export interface RecordingResult {
  blob: Blob;
  mime: AudioMime;
  /** Leading audio to skip at playback = time from recorder start to the first video frame. */
  offsetMs: number;
  /** Audible duration after the offset. */
  durationMs: number;
  /** performance.now() when the recorder actually started (`onstart`). */
  recStartedAt: number;
  /** performance.now() of the first presented video frame. */
  videoStartedAt: number;
}

/** Minimal MediaRecorder surface (lets tests inject a fake). */
export interface MediaRecorderLike {
  state: 'inactive' | 'recording' | 'paused';
  mimeType: string;
  onstart: ((ev: Event) => void) | null;
  onstop: ((ev: Event) => void) | null;
  ondataavailable: ((ev: { data: Blob }) => void) | null;
  onerror: ((ev: Event) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}
export type MediaRecorderFactory = (
  stream: MediaStream,
  opts: { mimeType: string; audioBitsPerSecond: number },
) => MediaRecorderLike;

export interface RecorderOptions {
  mime?: AudioMime;
  now?: () => number;
  createRecorder?: MediaRecorderFactory;
}

/**
 * Starts the video and resolves with the performance.now() time of its first presented frame.
 * Pass this (or your own) as `startVideo` to `Recorder.start`.
 */
export function playAndWaitFirstFrame(
  video: HTMLVideoElement,
  now: () => number = () => performance.now(),
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let done = false;
    let safety: ReturnType<typeof setTimeout> | null = null;
    const finish = (t: number) => {
      if (done) return;
      done = true;
      if (safety !== null) clearTimeout(safety);
      resolve(sanePresentationTime(t, now()));
    };
    if ('requestVideoFrameCallback' in video) {
      // One callback only (never re-armed), so this can't turn into a frame loop.
      video.requestVideoFrameCallback((t, meta) => finish(meta.presentationTime ?? t));
    } else {
      (video as HTMLVideoElement).addEventListener('playing', () => finish(now()), {
        once: true,
      });
    }
    // Safety net: rVFC never fires for a video that is already at its end.
    safety = setTimeout(() => finish(now()), 1500);
    video.play().catch((e: unknown) => {
      if (!done) {
        done = true;
        if (safety !== null) clearTimeout(safety);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

/**
 * The first frame's presentation time, or `now` when the browser hands us something outside
 * the `performance.now()` timebase (non-finite, in the future, or seconds in the past).
 */
export function sanePresentationTime(t: number, now: number): number {
  return Number.isFinite(t) && t <= now + 50 && t >= now - 2000 ? t : now;
}

/**
 * One take. Latency compensation (§2.3): `recorder.start()`; on `onstart` record `tRec` and
 * call `startVideo()`; when the first frame is presented record `tVid`.
 * `offsetMs = clamp(tVid - tRec, 0, 1000)`.
 */
export class Recorder {
  readonly mime: AudioMime;
  private readonly now: () => number;
  private readonly create: MediaRecorderFactory;
  private mr: MediaRecorderLike | null = null;
  private parts: Blob[] = [];
  private tRec = 0;
  private tVid = 0;
  private stopPromise: Promise<RecordingResult> | null = null;
  private cancelled = false;

  constructor(
    private readonly stream: MediaStream,
    opts: RecorderOptions = {},
  ) {
    const mime = opts.mime ?? pickRecorderMime();
    if (!mime)
      throw new Error('This browser cannot record audio (no supported MediaRecorder format).');
    this.mime = mime;
    this.now = opts.now ?? (() => performance.now());
    this.create =
      opts.createRecorder ?? ((s, o) => new MediaRecorder(s, o) as unknown as MediaRecorderLike);
  }

  get recording(): boolean {
    return this.mr?.state === 'recording';
  }

  /**
   * Starts recording, then the video. Resolves once the video's first frame is out (i.e. the
   * take is fully running) with the measured offset.
   */
  start(startVideo: () => Promise<number>): Promise<{ offsetMs: number }> {
    if (this.mr) throw new Error('Recorder already started');
    const mr = this.create(this.stream, {
      mimeType: this.mime,
      audioBitsPerSecond: RECORDER_BITRATE,
    });
    this.mr = mr;
    mr.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) this.parts.push(ev.data);
    };
    return new Promise((resolve, reject) => {
      mr.onerror = () => reject(new Error('Recording failed.'));
      mr.onstart = () => {
        this.tRec = this.now();
        startVideo().then(
          (tVid) => {
            this.tVid = tVid;
            resolve({ offsetMs: clampOffset(this.tVid - this.tRec) });
          },
          (e: unknown) => {
            this.cancel();
            reject(e instanceof Error ? e : new Error(String(e)));
          },
        );
      };
      mr.start(1000);
    });
  }

  /** Stops the take and returns the blob and timing. */
  stop(): Promise<RecordingResult> {
    if (this.stopPromise) return this.stopPromise;
    const mr = this.mr;
    if (!mr) return Promise.reject(new Error('Recorder not started'));
    const tStop = this.now();
    this.stopPromise = new Promise((resolve, reject) => {
      mr.onstop = () => {
        if (this.cancelled) return reject(new Error('cancelled'));
        const offsetMs = clampOffset(this.tVid ? this.tVid - this.tRec : 0);
        const total = Math.max(0, tStop - this.tRec);
        resolve({
          blob: new Blob(this.parts, { type: this.mime }),
          mime: this.mime,
          offsetMs,
          durationMs: Math.max(0, total - offsetMs),
          recStartedAt: this.tRec,
          videoStartedAt: this.tVid,
        });
      };
      if (mr.state !== 'inactive') mr.stop();
      else mr.onstop(new Event('stop'));
    });
    return this.stopPromise;
  }

  /** Abort without a result. */
  cancel(): void {
    this.cancelled = true;
    if (this.mr && this.mr.state !== 'inactive') {
      this.mr.onstop = null;
      this.mr.stop();
    }
    this.parts = [];
  }
}
