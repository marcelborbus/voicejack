import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS } from '@dub/shared';
import type { BotSound } from './BotPlayer.js';

/** `CLIPS_DIR/bot-sounds/`, written by `scripts/make-bot-sounds.mjs`. */
export const BOT_SOUNDS_DIR = 'bot-sounds';

interface BotSoundEntry {
  file: string;
  durationMs: number;
}

function parseManifest(raw: unknown): BotSoundEntry[] {
  const sounds = (raw as { sounds?: unknown } | null)?.sounds;
  if (!Array.isArray(sounds)) throw new Error('expected {sounds: [...]}');
  return sounds.filter(
    (x): x is BotSoundEntry =>
      typeof x?.file === 'string' &&
      /^[^/\\]+$/.test(x.file) &&
      Number.isInteger(x.durationMs) &&
      x.durationMs > 0,
  );
}

type Log = (msg: string) => void;

/** Snippets from `<clipsDir>/bot-sounds/manifest.json`; `[]` if missing or invalid. */
export function loadSoundPool(clipsDir: string, warn: Log = () => {}): BotSound[] {
  return loadSoundDir(path.join(clipsDir, BOT_SOUNDS_DIR), warn);
}

/** Snippets listed in `<dir>/manifest.json` ({sounds: [{file, durationMs}]}); `[]` if none. */
export function loadSoundDir(dir: string, warn: Log = () => {}): BotSound[] {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) return [];
  let entries: BotSoundEntry[];
  try {
    entries = parseManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    warn(`bot sounds: bad ${file}: ${(e as Error).message}`);
    return [];
  }
  const out: BotSound[] = [];
  for (const s of entries) {
    const p = path.join(dir, s.file);
    try {
      const data = fs.readFileSync(p);
      if (data.length === 0 || data.length > LIMITS.maxChunkBytes) continue;
      out.push({ name: s.file, durationMs: s.durationMs, mime: 'audio/webm;codecs=opus', data });
    } catch {
      warn(`bot sounds: missing ${p}`);
    }
  }
  return out;
}

function ffmpegToBuffer(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      args,
      { encoding: 'buffer', timeout: 10_000, maxBuffer: LIMITS.maxChunkBytes },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/** A few synthetic beeps/warbles (opus webm, in memory). `[]` if ffmpeg is unavailable. */
export async function synthesizeSounds(): Promise<BotSound[]> {
  // v1.2 #47: 3–5 s like the library snippets (3–8 s), so fallback dubs cover the clip too.
  const specs = [
    { freq: 440, ms: 3000, af: 'tremolo=f=8:d=0.8' },
    { freq: 660, ms: 3600, af: 'vibrato=f=6:d=0.5' },
    { freq: 330, ms: 4200, af: 'tremolo=f=4:d=0.6' },
    { freq: 880, ms: 3300, af: 'tremolo=f=12:d=0.9' },
    { freq: 520, ms: 5000, af: 'vibrato=f=3:d=0.7' },
  ];
  const out: BotSound[] = [];
  for (const s of specs) {
    try {
      const data = await ffmpegToBuffer([
        ...['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${s.freq}:duration=${s.ms / 1000}`],
        ...['-af', `${s.af},volume=0.4,afade=t=out:st=${(s.ms - 100) / 1000}:d=0.1`],
        ...['-ac', '1', '-c:a', 'libopus', '-b:a', '32k', '-f', 'webm', 'pipe:1'],
      ]);
      if (data.length > 0) {
        out.push({
          name: `synth-${s.freq}`,
          durationMs: s.ms,
          mime: 'audio/webm;codecs=opus',
          data,
        });
      }
    } catch {
      return out; // no ffmpeg (or no libopus): bots submit empty dubs
    }
  }
  return out;
}

/** Pool from disk, else synthetic tones, else `[]` (bots then submit empty dubs). */
export async function loadBotSounds(clipsDir: string, warn: Log = () => {}): Promise<BotSound[]> {
  const pool = loadSoundPool(clipsDir, warn);
  if (pool.length > 0) return pool;
  return synthesizeSounds();
}
