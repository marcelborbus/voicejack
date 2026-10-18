// v1.2 #47: the bot snippet recipe, shared by the server (`librarySounds.ts`) and
// `scripts/make-bot-sounds.mjs` (which imports this file directly with Node's type stripping,
// so it only uses node: imports and erasable TypeScript).
//
// Per source clip: one `silencedetect` pass finds the silent stretches; candidate windows of
// 3–8 s are trimmed to their first/last voiced moment and kept only when at least 70 % of the
// window is voiced. Each kept window is cut to mono opus webm with its loudness normalised
// (`loudnorm`), short fades, and `volumedetect` measuring the source level first: pieces whose
// mean volume is under −35 dBFS are dropped. ffmpeg always gets an argument array.
import fs from 'node:fs';
import path from 'node:path';

export const SNIPPET = {
  minMs: 3000,
  maxMs: 8000,
  /** Share of a window that must be voiced (not inside a detected silence). */
  minVoicedShare: 0.7,
  /** Mean volume (dBFS) of the source window below which it is dropped. */
  minMeanDb: -35,
  /** silencedetect threshold and minimum silence length. */
  silenceDb: -40,
  silenceMinMs: 300,
  /** At most this share of a new window may overlap an already kept one (same clip). */
  maxOverlap: 0.5,
  /** Only the first 10 minutes of a clip are analysed. */
  analyzeMaxMs: 600_000,
  /** loudnorm target (integrated LUFS, true peak dBTP). */
  loudnormI: -20,
  loudnormTp: -2,
} as const;

/** Bumped whenever the recipe changes: caches made with another recipe regenerate. */
export const SNIPPET_RECIPE = 'v2-3to8s-voiced70-loudnorm';

export type Interval = readonly [number, number];

export type Run = (cmd: string, args: string[]) => Promise<{ ok: boolean; stderr: string }>;

/** Silent stretches (ms) from silencedetect's stderr; an open silence runs to `totalMs`. */
export function parseSilences(stderr: string, totalMs: number): Interval[] {
  const out: Interval[] = [];
  let start: number | null = null;
  for (const m of stderr.matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
    const ms = Math.max(0, Math.round(Number(m[2]) * 1000));
    if (m[1] === 'start') start = ms;
    else if (start !== null) {
      out.push([start, Math.min(ms, totalMs)]);
      start = null;
    }
  }
  if (start !== null && start < totalMs) out.push([start, totalMs]);
  return out;
}

function overlap(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
}

/** Share (0–1) of `win` that lies outside every silence. */
export function voicedShare(win: Interval, silences: readonly Interval[]): number {
  const len = win[1] - win[0];
  if (len <= 0) return 0;
  let silent = 0;
  for (const s of silences) silent += overlap(win, s);
  return Math.max(0, 1 - silent / len);
}

/** `win` without its leading and trailing silence; null when it is silent throughout. */
export function trimToVoice(win: Interval, silences: readonly Interval[]): Interval | null {
  let [a, b] = win;
  let moved = true;
  while (moved && a < b) {
    moved = false;
    for (const s of silences) {
      if (s[0] <= a && s[1] > a) {
        a = s[1];
        moved = true;
      }
      if (s[0] < b && s[1] >= b) {
        b = s[0];
        moved = true;
      }
    }
  }
  return a < b ? [a, b] : null;
}

/**
 * One candidate window of a clip (`totalMs` long): random length and position, trimmed to its
 * voice. Null when it misses the length / voiced-share / overlap rules.
 */
export function pickWindow(
  totalMs: number,
  silences: readonly Interval[],
  rng: () => number,
  taken: readonly Interval[] = [],
): Interval | null {
  const maxLen = Math.min(SNIPPET.maxMs, totalMs);
  if (maxLen < SNIPPET.minMs) return null;
  const len = SNIPPET.minMs + rng() * (maxLen - SNIPPET.minMs);
  const start = rng() * (totalMs - len);
  const win = trimToVoice([Math.round(start), Math.round(start + len)], silences);
  if (!win || win[1] - win[0] < SNIPPET.minMs) return null;
  if (voicedShare(win, silences) < SNIPPET.minVoicedShare) return null;
  const n = win[1] - win[0];
  if (taken.some((t) => overlap(win, t) > n * SNIPPET.maxOverlap)) return null;
  return win;
}

const BASE = ['-hide_banner', '-nostats', '-nostdin', '-y', '-protocol_whitelist', 'file'];

/** Silences of the clip's audio (first `analyzeMaxMs`). Null when ffmpeg fails. */
export async function analyzeClip(
  run: Run,
  file: string,
  totalMs: number,
): Promise<Interval[] | null> {
  const ms = Math.min(totalMs, SNIPPET.analyzeMaxMs);
  const r = await run('ffmpeg', [
    ...BASE,
    ...['-t', (ms / 1000).toFixed(3), '-i', file, '-vn', '-ac', '1'],
    ...['-af', `silencedetect=noise=${SNIPPET.silenceDb}dB:d=${SNIPPET.silenceMinMs / 1000}`],
    ...['-f', 'null', '-'],
  ]);
  return r.ok ? parseSilences(r.stderr, ms) : null;
}

/** Mean volume (dBFS) from volumedetect output; -Infinity if absent or silent. */
export function parseMeanDb(stderr: string): number {
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr);
  return m && m[1] !== '-inf' ? Number(m[1]) : Number.NEGATIVE_INFINITY;
}

/**
 * Cuts `win` of `src` to `dest` (mono 48 kHz opus webm, loudness-normalised, faded). Returns
 * the source window's mean volume, or null when ffmpeg failed.
 */
export async function cutSnippet(
  run: Run,
  src: string,
  win: Interval,
  dest: string,
): Promise<number | null> {
  const len = (win[1] - win[0]) / 1000;
  const af = [
    'volumedetect', // source level, before normalising
    `loudnorm=I=${SNIPPET.loudnormI}:TP=${SNIPPET.loudnormTp}:LRA=11`,
    'aresample=48000',
    'afade=t=in:d=0.03',
    `afade=t=out:st=${Math.max(0, len - 0.06).toFixed(3)}:d=0.06`,
  ].join(',');
  const r = await run('ffmpeg', [
    ...BASE,
    ...['-ss', (win[0] / 1000).toFixed(3), '-t', len.toFixed(3), '-i', src],
    ...['-vn', '-ac', '1', '-ar', '48000', '-af', af],
    ...['-c:a', 'libopus', '-b:a', '32k', '-f', 'webm', dest],
  ]);
  if (!r.ok || !fs.existsSync(dest) || fs.statSync(dest).size === 0) {
    fs.rmSync(dest, { force: true });
    return null;
  }
  return parseMeanDb(r.stderr);
}

export interface CutSnippet {
  file: string;
  durationMs: number;
  startMs: number;
  meanDb: number;
}

/**
 * Up to `count` snippets of one clip into `outDir` (`<prefix>-<n>.webm`), following the recipe
 * above. `attempts` candidate windows per wanted snippet.
 */
export async function cutClipSnippets(
  run: Run,
  src: { file: string; durationMs: number },
  opts: { count: number; outDir: string; prefix: string; rng: () => number; attempts?: number },
): Promise<CutSnippet[]> {
  const silences = await analyzeClip(run, src.file, src.durationMs);
  if (!silences) return [];
  const totalMs = Math.min(src.durationMs, SNIPPET.analyzeMaxMs);
  const out: CutSnippet[] = [];
  const taken: Interval[] = [];
  const tries = opts.count * (opts.attempts ?? 8);
  for (let i = 0; i < tries && out.length < opts.count; i++) {
    const win = pickWindow(totalMs, silences, opts.rng, taken);
    if (!win) continue;
    const file = `${opts.prefix}-${out.length}.webm`;
    const dest = path.join(opts.outDir, file);
    const meanDb = await cutSnippet(run, src.file, win, dest);
    if (meanDb === null) continue;
    taken.push(win); // tried here: never retry the same stretch, kept or not
    if (meanDb < SNIPPET.minMeanDb) {
      fs.rmSync(dest, { force: true });
      continue;
    }
    out.push({ file, durationMs: win[1] - win[0], startMs: win[0], meanDb });
  }
  return out;
}
