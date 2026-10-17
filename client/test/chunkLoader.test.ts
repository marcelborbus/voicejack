import { beforeEach, describe, expect, it } from 'vitest';
import { clearChunkCache, loadChunkAudio } from '../src/dub/chunkLoader';

function fakeCtx() {
  return {
    decodeAudioData: (_d: ArrayBuffer, ok: (b: unknown) => void) => {
      const buf = {
        length: 4,
        sampleRate: 100,
        numberOfChannels: 1,
        duration: 0.04,
        getChannelData: () => new Float32Array(4),
      };
      ok(buf);
      return Promise.resolve(buf);
    },
  } as unknown as BaseAudioContext;
}

function fakeFetch() {
  const calls: { signal?: AbortSignal | null }[] = [];
  let fail = false;
  const f = (async (_url: string, init?: RequestInit) => {
    calls.push({ signal: init?.signal });
    await new Promise((r) => setTimeout(r, 5));
    if (fail) return new Response('x', { status: 500 });
    return new Response(new ArrayBuffer(8), { status: 200 });
  }) as typeof fetch;
  return { f, calls, setFail: (v: boolean) => (fail = v) };
}

describe('chunk cache', () => {
  beforeEach(() => clearChunkCache());

  it('an aborted load does not poison the cache for the next caller', async () => {
    const ctx = fakeCtx();
    const { f, calls } = fakeFetch();
    const ac = new AbortController();
    const first = loadChunkAudio(ctx, '/a', { fetch: f, signal: ac.signal });
    const second = loadChunkAudio(ctx, '/a', { fetch: f }); // e.g. StrictMode remount
    ac.abort();
    await expect(first).rejects.toThrow(/abort/i);
    await expect(second).resolves.toHaveProperty('buffer');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal).toBeUndefined(); // the shared download is never aborted
    await expect(loadChunkAudio(ctx, '/a', { fetch: f })).resolves.toHaveProperty('peaks');
    expect(calls).toHaveLength(1);
  });

  it('an already-aborted signal rejects without killing the shared load', async () => {
    const ctx = fakeCtx();
    const { f } = fakeFetch();
    const ac = new AbortController();
    ac.abort();
    await expect(loadChunkAudio(ctx, '/b', { fetch: f, signal: ac.signal })).rejects.toThrow();
    await expect(loadChunkAudio(ctx, '/b', { fetch: f })).resolves.toHaveProperty('buffer');
  });

  it('a failed download is dropped so the next call retries', async () => {
    const ctx = fakeCtx();
    const { f, calls, setFail } = fakeFetch();
    setFail(true);
    await expect(loadChunkAudio(ctx, '/c', { fetch: f })).rejects.toThrow(/500/);
    setFail(false);
    await expect(loadChunkAudio(ctx, '/c', { fetch: f })).resolves.toHaveProperty('buffer');
    expect(calls).toHaveLength(2);
  });
});
