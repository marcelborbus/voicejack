#!/usr/bin/env node
// Builds the redistributable clip library from scripts/clips.sources.json.
//
//   node scripts/fetch-clips.mjs [--dry-run] [--force] [--only id1,id2] [--out clips]
//
// For every cut it fetches just the needed segment of the remote source into
// .cache/clip-sources/<id>.src.mov (ffmpeg input seek over HTTP range requests,
// stream copy), re-encodes it to <out>/<id>.mp4 (H.264/AAC, <=720p, faststart),
// grabs a poster <out>/<id>.jpg and writes <out>/manifest.json. Entries with
// "local": true already in the manifest (owner-provided clips) are kept.
//
// Downloaded data is untrusted: it is only ever handed to ffmpeg/ffprobe as an
// explicit file path, never executed or interpreted otherwise.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = join(ROOT, 'scripts', 'clips.sources.json');
const CACHE = join(ROOT, '.cache', 'clip-sources');
const MAX_CLIP_SECONDS = 60;
const ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

function parseArgs(argv) {
  const opts = { dryRun: false, force: false, only: null, out: join(ROOT, 'clips') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--only') opts.only = new Set(argv[++i].split(',').filter(Boolean));
    else if (a === '--out') opts.out = resolve(argv[++i]);
    else if (a === '-h' || a === '--help') {
      console.log(
        'usage: node scripts/fetch-clips.mjs [--dry-run] [--force] [--only id1,id2] [--out dir]',
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function loadSources() {
  const { sources } = JSON.parse(readFileSync(SOURCES, 'utf8'));
  const seen = new Set();
  const cuts = [];
  for (const src of sources) {
    if (!/^https:\/\//.test(src.url)) throw new Error(`${src.key}: url must be https`);
    for (const k of ['author', 'source', 'license']) {
      if (!src.attribution?.[k]) throw new Error(`${src.key}: attribution.${k} missing`);
    }
    for (const cut of src.cuts) {
      if (!ID_RE.test(cut.id) || cut.id.length > 64) throw new Error(`bad clip id: ${cut.id}`);
      if (seen.has(cut.id)) throw new Error(`duplicate clip id: ${cut.id}`);
      seen.add(cut.id);
      if (!(cut.ss >= 0) || !(cut.t > 0) || cut.t > MAX_CLIP_SECONDS) {
        throw new Error(`${cut.id}: need ss >= 0 and 0 < t <= ${MAX_CLIP_SECONDS}`);
      }
      cuts.push({ ...cut, tags: cut.tags ?? [], source: src });
    }
  }
  return cuts;
}

function run(cmd, args, { capture = false } = {}) {
  const r = spawnSync(cmd, args, {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    encoding: 'utf8',
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const err = new Error(
      `${cmd} exited with ${r.status}${capture ? `: ${r.stderr.trim().slice(-500)}` : ''}`,
    );
    err.status = r.status;
    throw err;
  }
  return r.stdout;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** Fetch [ss, ss+t+1] of the remote source by stream copy. Timestamps stay aligned to `ss` (mov edit list). */
async function fetchSegment(cut, file) {
  const tmp = `${file}.part.mov`;
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-protocol_whitelist',
    'https,tls,tcp',
    '-reconnect',
    '1',
    '-reconnect_on_network_error',
    '1',
    '-reconnect_delay_max',
    '10',
    '-ss',
    String(cut.ss),
    '-i',
    cut.source.url,
    '-t',
    String(cut.t + 1),
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-c',
    'copy',
    '-sn',
    '-dn',
    '-f',
    'mov',
    tmp,
  ];
  for (let attempt = 1; ; attempt++) {
    try {
      run('ffmpeg', args, { capture: true });
      renameSync(tmp, file);
      return;
    } catch (e) {
      rmSync(tmp, { force: true });
      if (attempt >= 5) throw e;
      console.warn(`  fetch failed (attempt ${attempt}), retrying: ${e.message.split('\n')[0]}`);
      await sleep(2000 * attempt);
    }
  }
}

/** Square pixels, then fit inside w x h (never upscale), even dimensions. */
function fitFilter(w, h) {
  return (
    "scale='trunc(iw*sar/2)*2':ih,setsar=1," +
    `scale=w='min(${w},iw)':h='min(${h},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`
  );
}

function encode(cut, segFile, outFile) {
  const tmp = `${outFile}.part.mp4`;
  run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    segFile,
    '-t',
    String(cut.t),
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
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
    tmp,
  ]);
  renameSync(tmp, outFile);
}

function poster(cut, clipFile, posterFile) {
  const at = cut.poster ?? cut.t / 3;
  run('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    String(at),
    '-i',
    clipFile,
    '-frames:v',
    '1',
    '-vf',
    fitFilter(640, 360),
    '-q:v',
    '4',
    '-f',
    'image2',
    posterFile,
  ]);
}

function probe(file) {
  const out = run(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height:format=duration',
      '-of',
      'json',
      file,
    ],
    { capture: true },
  );
  const j = JSON.parse(out);
  const s = j.streams?.[0];
  const durationMs = Math.round(Number(j.format?.duration) * 1000);
  if (!s?.width || !s?.height || !(durationMs > 0))
    throw new Error(`ffprobe: unexpected output for ${file}`);
  return {
    width: s.width,
    height: s.height,
    durationMs: Math.min(durationMs, MAX_CLIP_SECONDS * 1000),
  };
}

function readManifest(file) {
  if (!existsSync(file)) return { clips: [] };
  try {
    const m = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(m.clips) ? m : { clips: [] };
  } catch {
    console.warn(`warning: could not parse ${file}; local entries cannot be preserved`);
    return { clips: [] };
  }
}

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${String(s.toFixed(0)).padStart(2, '0')}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let cuts = loadSources();
  if (opts.only) cuts = cuts.filter((c) => opts.only.has(c.id));
  const manifestFile = join(opts.out, 'manifest.json');
  const existing = readManifest(manifestFile);
  const local = existing.clips.filter((c) => c.local === true);

  if (opts.dryRun) {
    console.log(`Plan (${cuts.length} clips) -> ${opts.out}`);
    for (const c of cuts) {
      const done = existsSync(join(opts.out, `${c.id}.mp4`)) ? ' [exists]' : '';
      console.log(
        `  ${c.id.padEnd(24)} ${fmt(c.ss)} +${c.t}s  ${c.source.attribution.license.padEnd(14)} ${c.source.url}${done}`,
      );
    }
    console.log(
      `Segments cached in ${CACHE}; ${local.length} local manifest entr${local.length === 1 ? 'y' : 'ies'} preserved.`,
    );
    return;
  }

  mkdirSync(CACHE, { recursive: true });
  mkdirSync(opts.out, { recursive: true });
  const byId = new Map(existing.clips.filter((c) => !c.local).map((c) => [c.id, c]));
  const selected = new Set(cuts.map((c) => c.id));
  const entries = [];
  const failures = [];
  for (const c of loadSources()) {
    const clipFile = join(opts.out, `${c.id}.mp4`);
    const posterFile = join(opts.out, `${c.id}.jpg`);
    if (!selected.has(c.id)) {
      // Not selected via --only: keep the previous entry if its file is still there.
      const prev = byId.get(c.id);
      if (prev && existsSync(clipFile)) entries.push(prev);
      continue;
    }
    try {
      const segFile = join(CACHE, `${c.id}.src.mov`);
      if (opts.force || !existsSync(clipFile)) {
        if (opts.force || !existsSync(segFile)) {
          console.log(`fetch  ${c.id}  (${fmt(c.ss)} +${c.t}s)`);
          await fetchSegment(c, segFile);
        }
        console.log(`encode ${c.id}`);
        encode(c, segFile, clipFile);
      }
      if (opts.force || !existsSync(posterFile)) poster(c, clipFile, posterFile);
      const { width, height, durationMs } = probe(clipFile);
      const { attribution } = c.source;
      entries.push({
        id: c.id,
        title: c.title,
        file: `${c.id}.mp4`,
        durationMs,
        width,
        height,
        poster: `${c.id}.jpg`,
        tags: c.tags,
        attribution: {
          author: attribution.author,
          source: attribution.source,
          license: attribution.license,
          ...(attribution.licenseUrl ? { licenseUrl: attribution.licenseUrl } : {}),
        },
      });
      const mb = (statSync(clipFile).size / 1e6).toFixed(1);
      console.log(`ok     ${c.id}  ${(durationMs / 1000).toFixed(1)}s ${width}x${height} ${mb} MB`);
    } catch (e) {
      failures.push(c.id);
      console.error(`FAILED ${c.id}: ${e.message}`);
    }
  }

  const ids = new Set(entries.map((e) => e.id));
  const kept = local.filter((l) => !ids.has(l.id));
  const manifest = { clips: [...entries, ...kept] };
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${manifestFile}: ${entries.length} clips + ${kept.length} local`);
  if (failures.length) {
    console.error(`${failures.length} clip(s) failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
