import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasFfmpeg } from '../src/clips/normalize.js';
import {
  SNIPPET,
  cutClipSnippets,
  parseMeanDb,
  parseSilences,
  pickWindow,
  trimToVoice,
  voicedShare,
  type Interval,
  type Run,
} from '../src/bots/snippets.js';
import { tmpDir } from './helpers.js';

function seeded(seed = 3) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('snippet windows (v1.2 #47)', () => {
  it('parses silencedetect output, an open silence runs to the end', () => {
    const err = [
      '[silencedetect @ 0x1] silence_start: 0',
      '[silencedetect @ 0x1] silence_end: 1.5 | silence_duration: 1.5',
      '[silencedetect @ 0x1] silence_start: 4.25',
      '[silencedetect @ 0x1] silence_end: 5 | silence_duration: 0.75',
      '[silencedetect @ 0x1] silence_start: 9.1',
    ].join('\n');
    expect(parseSilences(err, 10_000)).toEqual([
      [0, 1500],
      [4250, 5000],
      [9100, 10_000],
    ]);
    expect(parseMeanDb('mean_volume: -23.4 dB')).toBe(-23.4);
    expect(parseMeanDb('mean_volume: -inf dB')).toBe(Number.NEGATIVE_INFINITY);
  });

  it('measures the voiced share and trims leading/trailing silence', () => {
    const sil: Interval[] = [
      [0, 1000],
      [3000, 4000],
      [8000, 10_000],
    ];
    expect(voicedShare([0, 10_000], sil)).toBeCloseTo(0.6);
    expect(voicedShare([1000, 3000], sil)).toBe(1);
    expect(trimToVoice([500, 9000], sil)).toEqual([1000, 8000]);
    expect(trimToVoice([3200, 3800], sil)).toBeNull();
  });

  it('only picks 3–8 s windows that are >= 70 % voiced and do not repeat a kept one', () => {
    // 4 s voice, 2 s silence, repeated over a minute.
    const sil: Interval[] = Array.from({ length: 10 }, (_, i) => [
      i * 6000 + 4000,
      i * 6000 + 6000,
    ]);
    const rng = seeded();
    const taken: Interval[] = [];
    for (let i = 0; i < 400; i++) {
      const w = pickWindow(60_000, sil, rng, taken);
      if (!w) continue;
      const len = w[1] - w[0];
      expect(len).toBeGreaterThanOrEqual(SNIPPET.minMs);
      expect(len).toBeLessThanOrEqual(SNIPPET.maxMs);
      expect(voicedShare(w, sil)).toBeGreaterThanOrEqual(SNIPPET.minVoicedShare);
      expect(trimToVoice(w, sil)).toEqual(w); // starts and ends on voice
      for (const t of taken) {
        const ov = Math.max(0, Math.min(w[1], t[1]) - Math.max(w[0], t[0]));
        expect(ov).toBeLessThanOrEqual(len * SNIPPET.maxOverlap);
      }
      taken.push(w);
    }
    expect(taken.length).toBeGreaterThan(5);
    // Mostly silence: nothing qualifies. Too short a clip: nothing either.
    expect(pickWindow(60_000, [[0, 59_000]], rng)).toBeNull();
    expect(pickWindow(2500, [], rng)).toBeNull();
  });
});

const run: Run = (cmd, args) =>
  new Promise((resolve) =>
    execFile(cmd, args, { maxBuffer: 4 << 20 }, (err, _o, stderr) =>
      resolve({ ok: !err, stderr: String(stderr) }),
    ),
  );

describe.skipIf(!hasFfmpeg())('snippet cutting (ffmpeg, v1.2 #47)', () => {
  it('keeps long, voiced, normalised snippets of tone bursts with silence between', async () => {
    const dir = tmpDir('dub-snip-');
    const src = path.join(dir, 'bursts.webm');
    // 30 s: 5 s of a quiet tone, then 2 s of silence, repeated.
    execFileSync('ffmpeg', [
      ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi'],
      ...['-i', 'sine=frequency=300:sample_rate=48000:duration=30'],
      ...['-af', "volume='if(lt(mod(t,7),5),0.8,0)':eval=frame"],
      ...['-c:a', 'libopus', '-b:a', '48k', src],
    ]);
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    const made = await cutClipSnippets(
      run,
      { file: src, durationMs: 30_000 },
      { count: 6, outDir: out, prefix: 'b', rng: seeded(11) },
    );
    expect(made.length).toBeGreaterThanOrEqual(3);
    for (const m of made) {
      expect(m.durationMs).toBeGreaterThanOrEqual(SNIPPET.minMs);
      expect(m.durationMs).toBeLessThanOrEqual(SNIPPET.maxMs);
      expect(m.meanDb).toBeGreaterThan(SNIPPET.minMeanDb);
      const file = path.join(out, m.file);
      expect(fs.statSync(file).size).toBeGreaterThan(0);
      // Re-measure the output: mostly not silence, and loud enough after loudnorm.
      const r = await run('ffmpeg', [
        ...['-hide_banner', '-nostats', '-i', file],
        ...['-af', 'silencedetect=noise=-40dB:d=0.3,volumedetect', '-f', 'null', '-'],
      ]);
      const sil = parseSilences(r.stderr, m.durationMs);
      expect(voicedShare([0, m.durationMs], sil)).toBeGreaterThanOrEqual(SNIPPET.minVoicedShare);
      expect(parseMeanDb(r.stderr)).toBeGreaterThan(-30);
    }
    // A quiet source (lavfi sine peaks at -18 dBFS; here about -36 dBFS peak, -39 mean) is
    // voiced for silencedetect but under the loudness floor: nothing is kept.
    const quiet = path.join(dir, 'quiet.webm');
    execFileSync('ffmpeg', [
      ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi'],
      ...['-i', 'sine=frequency=300:sample_rate=48000:duration=12'],
      ...['-af', 'volume=0.12', '-c:a', 'libopus', '-b:a', '48k', quiet],
    ]);
    const none = await cutClipSnippets(
      run,
      { file: quiet, durationMs: 12_000 },
      { count: 3, outDir: out, prefix: 'q', rng: seeded(5) },
    );
    expect(none).toEqual([]);
  }, 60_000);
});
