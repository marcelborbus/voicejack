import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { JobOptions } from '../clips/normalize.js';
import type { BotSound } from './BotPlayer.js';
import { loadBotSounds, loadSoundDir } from './sounds.js';
import { SNIPPET_RECIPE, cutClipSnippets, type CutSnippet } from './snippets.js';

/**
 * v1.2 #46: the bot sound pool cut from the official library's own clips, so admin test games
 * in prod (no `scripts/make-bot-sounds.mjs` run, no DEV_BOTS) still have bots that "speak".
 *
 * Same recipe as the script (`snippets.ts`, v1.2 #47): 3–8 s pieces of the enabled clips of every
 * official library that are at least 70 % voiced (silencedetect) and not too quiet (mean
 * > −35 dBFS), trimmed to their voice, loudness-normalised, mono opus webm. ffmpeg always gets
 * an argument array (never a shell), runs under `nice`, and the whole generation is one `low`
 * priority job on the shared clip `JobQueue`, so uploads always go first.
 *
 * Cached in `<LIBRARY_DIR>/.bot-sounds/` with the clip set's signature (which includes
 * `SNIPPET_RECIPE`) in its manifest. `get()` reuses the cache while the signature matches; when
 * the library changed it regenerates, at most once per `minRegenMs` (1 h; until then the old
 * pool keeps playing). A cache made with another recipe regenerates right away. Without ffmpeg or
 * clips it falls back to the dev pool / synthetic tones (`loadBotSounds`).
 */

export const BOT_SOUNDS_CACHE_DIR = '.bot-sounds';
/** Pool size aim (30–80); per clip at most `MAX_PER_CLIP`, from at most `MAX_SOURCE_CLIPS`. */
const TARGET_SNIPPETS = 60;
const MAX_PER_CLIP = 8;
const MAX_SOURCE_CLIPS = 30;
const FFMPEG_TIMEOUT_MS = 30_000;

/** What the pool needs from `ClipLibrary` (narrow, so tests can fake it). */
export interface SoundSourceLibrary {
  summaries(): readonly { id: string; visibility: string }[];
  clipsOf(libraryId: string): readonly { id: string; durationMs: number }[] | null;
  clipMeta(id: string): { file: string; dir: string | null } | null;
  readonly jobs: { push<T>(job: () => Promise<T>, opts?: JobOptions): Promise<T> | null };
}

export interface LibraryBotSoundsOptions {
  library: SoundSourceLibrary;
  /** `<LIBRARY_DIR>` (the cache goes into `.bot-sounds/` below it). */
  libraryDir: string;
  /** Fallback (`<CLIPS_DIR>/bot-sounds` or synthetic tones). */
  clipsDir: string;
  now?: () => number;
  minRegenMs?: number;
  rng?: () => number;
  log?: (msg: string) => void;
  /** Override ffmpeg detection (tests). */
  ffmpeg?: boolean;
}

interface Source {
  clipId: string;
  file: string;
  durationMs: number;
}

interface CacheManifest {
  source?: string;
  recipe?: string;
  generatedAt?: number;
  sounds?: unknown;
}

let niceOk: boolean | null = null;
function exec(cmd: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
  niceOk ??= spawnSync('nice', ['-n', '0', 'true']).status === 0;
  const [c, a] = niceOk ? ['nice', ['-n', '15', cmd, ...args]] : [cmd, args];
  return new Promise((resolve) => {
    execFile(
      c,
      a,
      { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' },
      (err, _stdout, stderr) => resolve({ ok: !err, stderr: String(stderr) }),
    );
  });
}

export class LibraryBotSounds {
  private pool: BotSound[] = [];
  private poolSig: string | null = null;
  private lastGenAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<BotSound[]> | null = null;
  private readonly now: () => number;
  private readonly rng: () => number;
  private readonly log: (msg: string) => void;
  private readonly minRegenMs: number;
  readonly dir: string;

  constructor(private readonly opts: LibraryBotSoundsOptions) {
    this.dir = path.join(opts.libraryDir, BOT_SOUNDS_CACHE_DIR);
    this.now = opts.now ?? Date.now;
    this.rng = opts.rng ?? Math.random;
    this.log = opts.log ?? (() => {});
    this.minRegenMs = opts.minRegenMs ?? 3600_000;
  }

  /** Enabled clips of every official library, in a stable order. */
  private sources(): Source[] {
    const lib = this.opts.library;
    const out: Source[] = [];
    for (const l of lib.summaries()) {
      if (l.visibility !== 'official') continue;
      for (const c of lib.clipsOf(l.id) ?? []) {
        const m = lib.clipMeta(c.id);
        if (!m?.dir) continue;
        const file = path.join(m.dir, m.file);
        if (fs.existsSync(file)) out.push({ clipId: c.id, file, durationMs: c.durationMs });
      }
    }
    return out.sort((a, b) => a.clipId.localeCompare(b.clipId));
  }

  private static signature(sources: Source[]): string {
    const h = createHash('sha256');
    h.update(`${SNIPPET_RECIPE}\n`);
    for (const s of sources) h.update(`${s.clipId}\u0000${s.file}\u0000${s.durationMs}\n`);
    return h.digest('hex').slice(0, 32);
  }

  private readCache(): CacheManifest | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, 'manifest.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * The current pool (filled lazily, see the class comment). Never rejects; concurrent calls
   * share one generation.
   */
  get(): Promise<BotSound[]> {
    if (this.inflight) return this.inflight;
    const p = this.resolve().catch((e: unknown) => {
      this.log(`bot sounds: ${(e as Error).message}`);
      return this.pool;
    });
    this.inflight = p.finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async resolve(): Promise<BotSound[]> {
    const sources = this.sources();
    const sig = LibraryBotSounds.signature(sources);
    if (this.poolSig === sig && this.pool.length > 0) return this.pool;
    if (this.poolSig === null) {
      const cache = this.readCache();
      const cached = cache ? loadSoundDir(this.dir, this.log) : [];
      if (cached.length > 0) {
        this.pool = cached;
        this.poolSig = typeof cache?.source === 'string' ? cache.source : 'unknown';
        // Another recipe (older, shorter snippets): regenerate now, not after the hourly limit.
        const sameRecipe = cache?.recipe === SNIPPET_RECIPE;
        this.lastGenAt =
          sameRecipe && typeof cache?.generatedAt === 'number'
            ? cache.generatedAt
            : Number.NEGATIVE_INFINITY;
        if (this.poolSig === sig) return this.pool;
      }
    }
    // Missing or stale: regenerate, but at most once per hour (keep playing the old pool).
    if (this.pool.length > 0 && this.now() - this.lastGenAt < this.minRegenMs) return this.pool;
    const ffmpeg = this.opts.ffmpeg ?? spawnSync('ffmpeg', ['-version']).status === 0;
    if (sources.length === 0 || !ffmpeg) {
      if (this.pool.length === 0) this.pool = await loadBotSounds(this.opts.clipsDir, this.log);
      return this.pool;
    }
    this.lastGenAt = this.now();
    const job = this.opts.library.jobs.push(() => this.generate(sources, sig), {
      priority: 'low',
    });
    const made = job ? await job : [];
    if (made.length > 0) {
      this.pool = made;
      this.poolSig = sig;
    } else if (this.pool.length === 0) {
      this.pool = await loadBotSounds(this.opts.clipsDir, this.log);
    }
    return this.pool;
  }

  /** Cuts the snippets into a temp dir, then swaps it in for `.bot-sounds/`. */
  private async generate(all: Source[], sig: string): Promise<BotSound[]> {
    const t0 = this.now();
    const sources = [...all];
    // Random sample of at most MAX_SOURCE_CLIPS clips (bounded work on a big library).
    for (let i = sources.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [sources[i], sources[j]] = [sources[j]!, sources[i]!];
    }
    sources.length = Math.min(sources.length, MAX_SOURCE_CLIPS);
    const perClip = Math.max(
      1,
      Math.min(MAX_PER_CLIP, Math.ceil(TARGET_SNIPPETS / sources.length)),
    );
    const tmp = `${this.dir}.tmp`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const sounds: (CutSnippet & { clipId: string })[] = [];
    for (const [n, src] of sources.entries()) {
      const made = await cutClipSnippets(exec, src, {
        count: perClip,
        outDir: tmp,
        prefix: `s${String(n).padStart(2, '0')}`,
        rng: this.rng,
      });
      for (const m of made) sounds.push({ ...m, clipId: src.clipId });
    }
    const manifest = { source: sig, recipe: SNIPPET_RECIPE, generatedAt: t0, sounds };
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.renameSync(tmp, this.dir);
    const pool = loadSoundDir(this.dir, this.log);
    this.log(`bot sounds: ${pool.length} snippets from ${sources.length} library clips`);
    return pool;
  }
}
