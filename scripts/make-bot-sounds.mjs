#!/usr/bin/env node
// Builds the dev-bot sound pool (V01): short opus-webm snippets cut from the clips' own audio.
//
//   node scripts/make-bot-sounds.mjs [--clips clips] [--per-clip 4] [--seed 1]
//
// Reads <clips>/manifest.json, cuts --per-clip pieces of 0.5–3 s at random positions from each
// clip that exists on disk, skips near-silent pieces, and writes <clips>/bot-sounds/*.webm plus
// <clips>/bot-sounds/manifest.json ({sounds: [{file, durationMs, clipId, startMs}]}).
// The output is gitignored media like the clips themselves. Needs ffmpeg + ffprobe.
// The server does the same at runtime from the official library (server/src/bots/librarySounds.ts,
// cached in LIBRARY_DIR/.bot-sounds); this dev pool is only its fallback.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIN_MS = 500;
const MAX_MS = 3000;
/** Pieces quieter than this (mean volume, dBFS) are discarded. */
const SILENCE_DB = -40;

function parseArgs(argv) {
  const opts = { clips: join(ROOT, 'clips'), perClip: 4, seed: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--clips') opts.clips = resolve(argv[++i]);
    else if (a === '--per-clip') opts.perClip = Number(argv[++i]);
    else if (a === '--seed') opts.seed = Number(argv[++i]);
    else {
      console.error(`unknown argument ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

/** Small deterministic PRNG so reruns produce the same pool. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error) throw r.error;
  return r;
}

function meanVolume(file) {
  const r = run('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr);
  return m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : -Infinity;
}

function probeMs(file) {
  const r = run('ffprobe', [
    ...['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
  ]);
  const s = Number(r.stdout.trim());
  return Number.isFinite(s) ? Math.round(s * 1000) : 0;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(join(opts.clips, 'manifest.json'), 'utf8'));
  const out = join(opts.clips, 'bot-sounds');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const rng = mulberry32(opts.seed);
  const sounds = [];
  for (const clip of manifest.clips) {
    const src = join(opts.clips, clip.file);
    if (!existsSync(src)) {
      console.warn(`skip ${clip.id}: ${clip.file} missing`);
      continue;
    }
    let made = 0;
    for (let attempt = 0; made < opts.perClip && attempt < opts.perClip * 3; attempt++) {
      const len = Math.round(MIN_MS + rng() * (MAX_MS - MIN_MS));
      if (clip.durationMs < len) continue;
      const startMs = Math.floor(rng() * (clip.durationMs - len));
      const file = `${clip.id}-${String(made).padStart(2, '0')}.webm`;
      const dest = join(out, file);
      const r = run('ffmpeg', [
        ...['-v', 'error', '-y', '-ss', (startMs / 1000).toFixed(3), '-t', (len / 1000).toFixed(3)],
        ...['-i', src, '-vn', '-ac', '1', '-ar', '48000'],
        ...['-af', 'afade=t=in:d=0.03,areverse,afade=t=in:d=0.05,areverse'],
        ...['-c:a', 'libopus', '-b:a', '32k', '-f', 'webm', dest],
      ]);
      if (r.status !== 0 || !existsSync(dest)) {
        console.warn(`ffmpeg failed for ${clip.id} @${startMs}: ${r.stderr.trim()}`);
        continue;
      }
      if (meanVolume(dest) < SILENCE_DB) {
        rmSync(dest);
        continue;
      }
      const durationMs = probeMs(dest) || len;
      sounds.push({ file, durationMs, clipId: clip.id, startMs });
      made++;
    }
    console.log(`${clip.id}: ${made} snippet(s)`);
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ sounds }, null, 2) + '\n');
  console.log(`wrote ${sounds.length} snippets to ${out}`);
}

main();
