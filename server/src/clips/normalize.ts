import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
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

/** Runs jobs strictly one after another; refuses new ones beyond `maxPending`. */
export class JobQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  constructor(readonly maxPending = 5) {}

  get size(): number {
    return this.pending;
  }

  /** Null if the queue is full; else the job's promise. */
  push<T>(job: () => Promise<T>): Promise<T> | null {
    if (this.pending >= this.maxPending) return null;
    this.pending++;
    const p = this.tail.then(job).finally(() => this.pending--);
    this.tail = p.catch(() => {});
    return p;
  }

  /** Resolves once everything queued so far has finished. */
  idle(): Promise<void> {
    return this.tail.then(() => {});
  }
}
