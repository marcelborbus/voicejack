import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClipLibrary, VARIANTS_DIR } from '../src/clips/ClipLibrary.js';
import { encodeLow, hasFfmpeg, JobQueue, probe } from '../src/clips/normalize.js';
import { ClipVariants } from '../src/clips/variants.js';
import { openDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { makeClipsDir, tmpDir } from './helpers.js';

function open() {
  const db = openDb(path.join(tmpDir('dub-var-db-'), 'v.sqlite'));
  migrate(db);
  const libraryDir = tmpDir('dub-var-lib-');
  return { lib: ClipLibrary.open(db, { clipsDir: makeClipsDir(3), libraryDir }), libraryDir };
}

describe('480p clip renditions (#53)', () => {
  it('makes the missing ones one low job at a time, then serves them as ClipInfo.lowUrl', async () => {
    const { lib, libraryDir } = open();
    const id = lib.defaultId()!;
    expect(lib.clipsOf(id)!.every((c) => c.lowUrl === undefined)).toBe(true);
    expect(lib.missingVariants()).toHaveLength(3);
    const done: string[] = [];
    const variants = new ClipVariants(lib, {
      encode: async (input, output) => {
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, 'low');
        done.push(path.basename(input));
      },
    });
    variants.pump();
    await expect.poll(() => done.length).toBe(3);
    await variants.idle();
    expect(done.sort()).toEqual(['clip-0.mp4', 'clip-1.mp4', 'clip-2.mp4']);
    expect(lib.missingVariants()).toEqual([]);
    const c = lib.clipsOf(id)![0]!;
    expect(c.lowUrl).toBe(`/clips/${id}/clip-0-480.mp4`);
    expect(lib.serveDir(id, 'clip-0-480.mp4')).toBe(path.join(libraryDir, VARIANTS_DIR, id));
    variants.stop();
  });

  it('a failing clip is skipped (no retry loop), the others still get made', async () => {
    const { lib } = open();
    let calls = 0;
    const variants = new ClipVariants(lib, {
      encode: async (input, output) => {
        calls++;
        if (input.endsWith('clip-1.mp4')) throw new Error('corrupt');
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, 'low');
      },
    });
    variants.pump();
    await expect.poll(() => lib.missingVariants().length).toBe(1);
    await variants.idle();
    expect(calls).toBe(3);
    variants.stop();
  });

  it('JobQueue: the renditions and the bot sound pool each get their own low slot', () => {
    const q = new JobQueue();
    const never = () => new Promise<void>(() => {});
    expect(q.push(never, { priority: 'low' })).not.toBeNull(); // bot sounds
    expect(q.push(never, { priority: 'low' })).toBeNull();
    expect(q.push(never, { priority: 'low', owner: 'clip-variants' })).not.toBeNull();
    expect(q.push(never, { priority: 'low', owner: 'clip-variants' })).toBeNull();
  });

  it.skipIf(!hasFfmpeg())(
    'encodeLow: ≤480p, video only, faststart mp4',
    async () => {
      const dir = tmpDir('dub-var-enc-');
      const input = path.join(dir, 'in.mp4');
      execFileSync('ffmpeg', [
        ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi'],
        ...['-i', 'testsrc=size=1280x720:rate=25:duration=2', '-f', 'lavfi'],
        ...['-i', 'sine=frequency=330:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast'],
        ...['-c:a', 'aac', '-shortest', input],
      ]);
      const out = path.join(dir, 'v', 'in-480.mp4');
      await encodeLow(input, out);
      const p = await probe(out);
      expect(p.height).toBe(480);
      expect(p.width).toBe(854);
      expect(p.hasAudio).toBe(false);
    },
    60_000,
  );
});
