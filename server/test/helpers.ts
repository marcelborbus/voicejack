import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../src/config.js';

export function tmpDir(prefix = 'dub-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Writes a manifest with `n` clips (dummy bytes unless real files are provided). */
export function makeClipsDir(n = 3, durationMs = 8000): string {
  const dir = tmpDir('dub-clips-');
  const clips = Array.from({ length: n }, (_, i) => {
    const file = `clip-${i}.mp4`;
    fs.writeFileSync(path.join(dir, file), Buffer.alloc(4096, i));
    return {
      id: `clip-${i}`,
      title: `Clip ${i}`,
      file,
      durationMs,
      width: 640,
      height: 360,
      tags: i % 2 === 0 ? ['even'] : ['odd'],
      attribution: { author: 'test', source: 'generated', license: 'CC0' },
    };
  });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ clips }));
  return dir;
}

export function testConfig(over: Partial<Config> = {}, env: NodeJS.ProcessEnv = {}): Config {
  return {
    ...loadConfig({ TIMINGS: 'fast', ...env }),
    port: 0,
    host: '127.0.0.1',
    clientDist: path.join(os.tmpdir(), 'dub-no-client'),
    dataDir: tmpDir('dub-data-'),
    ...over,
  };
}
