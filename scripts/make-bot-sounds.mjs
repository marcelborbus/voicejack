#!/usr/bin/env node
// Builds the dev-bot sound pool (V01): opus-webm snippets cut from the clips' own audio.
//
//   node scripts/make-bot-sounds.mjs [--clips clips] [--per-clip 6] [--seed 1]
//
// Reads <clips>/manifest.json and cuts up to --per-clip snippets from each clip that exists on
// disk, with the server's recipe (server/src/bots/snippets.ts, imported directly via Node's
// type stripping, v1.2 #47): 3–8 s windows that are >= 70 % voiced (silencedetect), trimmed to
// their voice, mean volume > -35 dBFS, loudness-normalised. Writes <clips>/bot-sounds/*.webm
// plus <clips>/bot-sounds/manifest.json ({sounds: [{file, durationMs, clipId, startMs}]}).
// The output is gitignored media like the clips themselves. Needs ffmpeg.
// The server does the same at runtime from the official library (server/src/bots/librarySounds.ts,
// cached in LIBRARY_DIR/.bot-sounds); this dev pool is only its fallback.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNIPPET, SNIPPET_RECIPE, cutClipSnippets } from '../server/src/bots/snippets.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = { clips: join(ROOT, 'clips'), perClip: 6, seed: 1 };
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

/** ffmpeg with an argument array (never a shell); resolves {ok, stderr}. */
function run(cmd, args) {
  return new Promise((done) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', (e) => done({ ok: false, stderr: String(e) }));
    p.on('close', (code) => done({ ok: code === 0, stderr }));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(join(opts.clips, 'manifest.json'), 'utf8'));
  const out = join(opts.clips, 'bot-sounds');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const rng = mulberry32(opts.seed);
  const sounds = [];
  for (const clip of manifest.clips) {
    const file = join(opts.clips, clip.file);
    if (!existsSync(file)) {
      console.warn(`skip ${clip.id}: ${clip.file} missing`);
      continue;
    }
    const made = await cutClipSnippets(
      run,
      { file, durationMs: clip.durationMs },
      { count: opts.perClip, outDir: out, prefix: clip.id, rng },
    );
    for (const m of made) {
      sounds.push({ file: m.file, durationMs: m.durationMs, clipId: clip.id, startMs: m.startMs });
    }
    console.log(`${clip.id}: ${made.length} snippet(s)`);
  }
  writeFileSync(
    join(out, 'manifest.json'),
    JSON.stringify({ recipe: SNIPPET_RECIPE, sounds }, null, 2) + '\n',
  );
  const secs = sounds.map((s) => s.durationMs / 1000);
  const avg = secs.length ? secs.reduce((a, b) => a + b, 0) / secs.length : 0;
  console.log(
    `wrote ${sounds.length} snippets (${SNIPPET.minMs / 1000}-${SNIPPET.maxMs / 1000} s, ` +
      `avg ${avg.toFixed(1)} s) to ${out}`,
  );
}

await main();
