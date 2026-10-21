import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LIBRARY_CLIP_MAX_SECONDS } from '@dub/shared';

/**
 * Server-side clip normalization for uploads (V05): H.264/AAC mp4 ≤720p with faststart, trimmed
 * to ≤60 s, plus a poster jpg. ffmpeg/ffprobe always get an argument array (never a shell),
 * run under `nice`, one job at a time (`JobQueue`).
 *
 * Uploaded bytes are untrusted: only plain container demuxers and the `file` protocol are
 * allowed, so playlists (HLS, concat, …) cannot make ffmpeg read other files or URLs.
 */

/** Demuxers an upload may use (mp4/mov, mkv/webm, avi, ts, flv, ogg, mpeg-ps, wmv). */
export const INPUT_FORMATS = 'mov,matroska,avi,mpegts,flv,ogg,mpeg,asf';
const INPUT_GUARD = ['-protocol_whitelist', 'file', '-format_whitelist', INPUT_FORMATS];
const PROBE_TIMEOUT_MS = 30_000;
const ENCODE_TIMEOUT_MS = 10 * 60_000;

let niceAvailable: boolean | null = null;
function withNice(cmd: string, args: string[]): [string, string[]] {
  niceAvailable ??= spawnSync('nice', ['-n', '0', 'true']).status === 0;
  return niceAvailable ? ['nice', ['-n', '10', cmd, ...args]] : [cmd, args];
}

/** True if ffmpeg and ffprobe can be run. */
export function hasFfmpeg(): boolean {
  return (
    spawnSync('ffmpeg', ['-version']).status === 0 &&
    spawnSync('ffprobe', ['-version']).status === 0
  );
}

function run(cmd: string, args: string[], timeout: number, nice = false): Promise<string> {
  const [c, a] = nice ? withNice(cmd, args) : [cmd, args];
  return new Promise((resolve, reject) => {
    execFile(
      c,
      a,
      { timeout, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr).trim().split('\n').slice(-3).join(' ').slice(0, 300);
          reject(new Error(`${cmd} failed${tail ? `: ${tail}` : ''}`));
        } else resolve(String(stdout));
      },
    );
  });
}

export interface ProbeResult {
  durationMs: number;
  width: number;
  height: number;
  hasAudio: boolean;
  format: string;
}

/** ffprobe `file`; rejects anything without a video stream and a positive duration. */
export async function probe(file: string): Promise<ProbeResult> {
  const out = await run(
    'ffprobe',
    [
      ...INPUT_GUARD,
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,width,height:format=duration,format_name',
      '-of',
      'json',
      file,
    ],
    PROBE_TIMEOUT_MS,
  ).catch(() => {
    throw new Error('not a supported video file');
  });
  let j: {
    streams?: { codec_type?: string; width?: number; height?: number }[];
    format?: { duration?: string; format_name?: string };
  };
  try {
    j = JSON.parse(out);
  } catch {
    throw new Error('not a supported video file');
  }
  const video = j.streams?.find((s) => s.codec_type === 'video' && s.width && s.height);
  const durationMs = Math.round(Number(j.format?.duration) * 1000);
  if (!video || !(durationMs > 0)) throw new Error('no video stream found');
  return {
    durationMs,
    width: video.width!,
    height: video.height!,
    hasAudio: !!j.streams?.some((s) => s.codec_type === 'audio'),
    format: j.format?.format_name ?? '',
  };
}

/** Square pixels, then fit inside w x h (never upscale), even dimensions (as fetch-clips.mjs). */
function fitFilter(w: number, h: number): string {
  return (
    "scale='trunc(iw*sar/2)*2':ih,setsar=1," +
    `scale=w='min(${w},iw)':h='min(${h},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`
  );
}

/**
 * #53: 480p, video only (the showcase / final replay play muted), faststart. Atomic via `.part`.
 * Same input guard as uploads; runs under `nice` with one thread.
 */
export async function encodeLow(input: string, outFile: string): Promise<void> {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const part = `${outFile}.part`;
  try {
    await run(
      'ffmpeg',
      [
        ...['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'],
        ...['-protocol_whitelist', 'file', '-i', input],
        ...['-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1'],
        ...['-vf', fitFilter(854, 480)],
        ...['-c:v', 'libx264', '-crf', '28', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'],
        ...['-threads', '1', '-movflags', '+faststart', '-f', 'mp4', part],
      ],
      ENCODE_TIMEOUT_MS,
      true,
    );
    fs.renameSync(part, outFile);
  } finally {
    fs.rmSync(part, { force: true });
  }
}

export interface TrimRequest {
  /** Start offset in seconds (default 0). */
  ss?: number;
  /** Length in seconds (default: to the end, at most 60). */
  t?: number;
}

/** Resolves the trim window against the probed input; throws a user-facing message if invalid. */
export function resolveTrim(input: ProbeResult, req: TrimRequest): { ss: number; t: number } {
  const total = input.durationMs / 1000;
  const ss = req.ss ?? 0;
  if (!(ss >= 0) || ss >= total - 0.5) {
    throw new Error(`start ${ss}s is past the end of the video (${total.toFixed(1)}s)`);
  }
  const t = Math.min(req.t ?? LIBRARY_CLIP_MAX_SECONDS, LIBRARY_CLIP_MAX_SECONDS, total - ss);
  if (!(t >= 1)) throw new Error('clip would be shorter than 1 s');
  return { ss: Math.round(ss * 1000) / 1000, t: Math.round(t * 1000) / 1000 };
}

export interface NormalizeResult {
  durationMs: number;
  width: number;
  height: number;
  bytes: number;
  poster: boolean;
}

/** Encodes `input` (already probed) into `outFile` (+ `posterFile`). Atomic via `.part` rename. */
export async function normalize(opts: {
  input: string;
  probe: ProbeResult;
  trim: { ss: number; t: number };
  outFile: string;
  posterFile: string;
}): Promise<NormalizeResult> {
  const part = `${opts.outFile}.part`;
  try {
    await run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-y',
        ...INPUT_GUARD,
        '-ss',
        String(opts.trim.ss),
        '-i',
        opts.input,
        '-t',
        String(opts.trim.t),
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-sn',
        '-dn',
        '-map_metadata',
        '-1',
        '-vf',
        fitFilter(1280, 720),
        '-c:v',
        'libx264',
        '-crf',
        '26',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-threads',
        '2',
        '-c:a',
        'aac',
        '-b:a',
        '96k',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        part,
      ],
      ENCODE_TIMEOUT_MS,
      true,
    );
    fs.renameSync(part, opts.outFile);
  } finally {
    fs.rmSync(part, { force: true });
  }
  const out = await probe(opts.outFile);
  let poster = true;
  try {
    await run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-y',
        '-ss',
        String(Math.round((out.durationMs / 3000) * 100) / 100),
        '-i',
        opts.outFile,
        '-frames:v',
        '1',
        '-vf',
        fitFilter(640, 360),
        '-q:v',
        '4',
        '-f',
        'image2',
        opts.posterFile,
      ],
      PROBE_TIMEOUT_MS,
      true,
    );
  } catch {
    poster = false;
  }
  return {
    durationMs: Math.min(out.durationMs, LIBRARY_CLIP_MAX_SECONDS * 1000),
    width: out.width,
    height: out.height,
    bytes: fs.statSync(opts.outFile).size,
    poster: poster && fs.existsSync(opts.posterFile),
  };
}

/** v1.2 #46: `low` = background work (bot sound pool) after every admin and user job. */
export type JobPriority = 'admin' | 'user' | 'low';

export interface JobOptions {
  /** Admin jobs run before queued user jobs, user jobs before `low` ones (default 'admin'). */
  priority?: JobPriority;
  /** Job owner (user id) for the per-owner limit. */
  owner?: string;
}

interface QueuedJob {
  run: () => Promise<void>;
  priority: JobPriority;
  owner: string | undefined;
}

/**
 * One normalize queue shared by admin and user uploads (V06): jobs run strictly one at a time,
 * queued admin jobs first, then user jobs, each in arrival order. Admin and user jobs have
 * separate caps (`maxPending`, `maxUserPending`, queued + running) and an owner may have at
 * most `maxPerOwner` (queued + running).
 */
export class JobQueue {
  private readonly queue: QueuedJob[] = [];
  private running: QueuedJob | null = null;
  private idleWaiters: (() => void)[] = [];

  constructor(
    readonly maxPending = 5,
    readonly maxUserPending = 10,
    readonly maxPerOwner = 1,
  ) {}

  /** Queued + running jobs. */
  get size(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  private all(): QueuedJob[] {
    return this.running ? [this.running, ...this.queue] : this.queue;
  }

  sizeOf(priority: JobPriority): number {
    return this.all().filter((j) => j.priority === priority).length;
  }

  /** Queued + running jobs of `owner`. */
  pendingFor(owner: string): number {
    return this.all().filter((j) => j.owner === owner).length;
  }

  /** Why a job with `opts` would be refused right now, or null if it fits. */
  refusal(opts: JobOptions = {}): 'busy' | 'owner' | null {
    const priority = opts.priority ?? 'admin';
    if (opts.owner && this.pendingFor(opts.owner) >= this.maxPerOwner) return 'owner';
    // `low`: one queued-or-running job per kind of background work (#53: the bot sound pool
    // and the 480p renditions each get theirs; they still run one at a time like everything).
    if (priority === 'low') {
      const same = this.all().filter((j) => j.priority === 'low' && j.owner === opts.owner);
      return same.length >= 1 ? 'busy' : null;
    }
    const cap = priority === 'admin' ? this.maxPending : this.maxUserPending;
    return this.sizeOf(priority) >= cap ? 'busy' : null;
  }

  /** Null if the job is refused (see `refusal`); else the job's promise. */
  push<T>(job: () => Promise<T>, opts: JobOptions = {}): Promise<T> | null {
    if (this.refusal(opts)) return null;
    const priority = opts.priority ?? 'admin';
    return new Promise<T>((resolve, reject) => {
      const q: QueuedJob = {
        priority,
        owner: opts.owner,
        run: () => Promise.resolve().then(job).then(resolve, reject),
      };
      // Insert after every queued job of the same or a higher priority.
      const rank = { admin: 0, user: 1, low: 2 } as const;
      const after = this.queue.findIndex((j) => rank[j.priority] > rank[priority]);
      this.queue.splice(after < 0 ? this.queue.length : after, 0, q);
      this.next();
    });
  }

  private next(): void {
    if (this.running) return;
    const j = this.queue.shift();
    if (!j) {
      const w = this.idleWaiters;
      this.idleWaiters = [];
      for (const fn of w) fn();
      return;
    }
    this.running = j;
    void j.run().finally(() => {
      this.running = null;
      this.next();
    });
  }

  /** Resolves once the queue is empty and nothing runs. */
  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((res) => this.idleWaiters.push(res));
  }
}
