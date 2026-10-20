import { PLAYER_TOKEN_HEADER, type ChunkMeta } from '@dub/shared';
import { describe, expect, it, vi } from 'vitest';
import { restorable } from '../src/editor/restore';
import { UploadQueue, type UploadQueueDeps, type UploadState } from '../src/editor/uploadQueue';

const meta = (id: string, startMs: number): ChunkMeta => ({
  id,
  startMs,
  offsetMs: 40,
  durationMs: 1200,
  mime: 'audio/webm;codecs=opus',
  bytes: 10,
});
const blob = () => new Blob([new Uint8Array(10)], { type: 'audio/webm;codecs=opus' });
const flush = () => new Promise((r) => setTimeout(r, 0));

type Reply = number | 'throw';

function setup(replies: Record<string, Reply[]> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const manifests: string[][] = [];
  const states: [string, UploadState][] = [];
  const errors: string[] = [];
  // Per-chunk queue of replies; default 201.
  const gates = new Map<string, (() => void)[]>();
  const deps: UploadQueueDeps = {
    fetch: vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const id = url.split('/').pop()!;
      const r = replies[id]?.shift() ?? 201;
      if (r === 'throw') throw new Error('offline');
      return {
        ok: r >= 200 && r < 300,
        status: r,
        json: async () =>
          r >= 400
            ? { error: r === 409 ? 'BAD_PHASE' : 'LIMIT', message: 'nope' }
            : { id, bytes: 10 },
      };
    }),
    sendManifest: (_round, chunks) => manifests.push(chunks.map((c) => c.id)),
    getToken: () => 'tok',
    onState: (id, s) => states.push([id, s]),
    onError: (id) => errors.push(id),
    sleep: () => Promise.resolve(),
  };
  const q = new UploadQueue({ code: 'ABCDEF', round: 1, deps });
  return { q, calls, manifests, states, errors, gates };
}

describe('UploadQueue', () => {
  it('uploads with token and mime, then sends the full manifest', async () => {
    const t = setup();
    t.q.add(meta('a', 500), blob());
    expect(t.manifests.at(-1)).toEqual(['a']); // pending chunk already listed
    await t.q.whenIdle();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.url).toBe('/api/rooms/ABCDEF/rounds/1/chunks/a');
    const h = t.calls[0]!.init.headers as Record<string, string>;
    expect(h[PLAYER_TOKEN_HEADER]).toBe('tok');
    expect(h['Content-Type']).toBe('audio/webm;codecs=opus');
    expect(t.calls[0]!.init.method).toBe('POST');
    expect(t.q.state('a')).toBe('uploaded');
    expect(t.manifests.length).toBeGreaterThanOrEqual(2); // re-sent after the upload
    expect(t.manifests.at(-1)).toEqual(['a']);
  });

  it('retries 3 times on network / 5xx errors, then succeeds', async () => {
    const t = setup({ a: ['throw', 503, 500] });
    t.q.add(meta('a', 0), blob());
    await t.q.whenIdle();
    expect(t.calls).toHaveLength(4);
    expect(t.q.state('a')).toBe('uploaded');
    expect(t.errors).toEqual([]);
  });

  it('gives up after 3 retries; failed chunks leave the manifest; retry brings them back', async () => {
    const t = setup({ a: ['throw', 'throw', 'throw', 'throw'] });
    t.q.add(meta('b', 2000), blob());
    t.q.add(meta('a', 0), blob());
    await t.q.whenIdle();
    expect(t.calls.filter((c) => c.url.endsWith('/a'))).toHaveLength(4);
    expect(t.q.state('a')).toBe('failed');
    expect(t.errors).toEqual(['a']);
    expect(t.q.manifest().map((c) => c.id)).toEqual(['b']);
    expect(t.manifests.at(-1)).toEqual(['b']);
    t.q.retry('a');
    expect(t.manifests.at(-1)).toEqual(['a', 'b']); // pending again, sorted by start
    await t.q.whenIdle();
    expect(t.q.state('a')).toBe('uploaded');
  });

  it('does not retry final errors (409 phase over)', async () => {
    const t = setup({ a: [409] });
    t.q.add(meta('a', 0), blob());
    await t.q.whenIdle();
    expect(t.calls).toHaveLength(1);
    expect(t.q.state('a')).toBe('failed');
  });

  it('deleted chunks drop out of the manifest, even mid-upload', async () => {
    const t = setup({ a: ['throw'] });
    t.q.add(meta('a', 0), blob());
    t.q.add(meta('b', 100), blob());
    t.q.remove('a');
    expect(t.manifests.at(-1)).toEqual(['b']);
    await t.q.whenIdle();
    await flush();
    expect(t.q.state('a')).toBeNull();
    expect(t.manifests.at(-1)).toEqual(['b']);
    // The stale upload loop of 'a' never retried.
    expect(t.calls.filter((c) => c.url.endsWith('/a'))).toHaveLength(1);
  });

  it('re-record replaces the old chunk in one manifest', async () => {
    const t = setup();
    t.q.add(meta('a', 0), blob());
    await t.q.whenIdle();
    const before = t.manifests.length;
    t.q.add(meta('a2', 0), blob(), 'a');
    expect(t.manifests.length).toBe(before + 1);
    expect(t.manifests.at(-1)).toEqual(['a2']);
    await t.q.whenIdle();
    expect(t.q.manifest().map((c) => c.id)).toEqual(['a2']);
  });

  it('adopted (restored) chunks count as uploaded and are not re-sent', async () => {
    const t = setup();
    t.q.adopt(meta('r', 300));
    expect(t.q.manifest().map((c) => c.id)).toEqual(['r']);
    expect(t.calls).toHaveLength(0);
    t.q.add(meta('n', 100), blob());
    await t.q.whenIdle();
    expect(t.manifests.at(-1)).toEqual(['n', 'r']);
  });

  it('skips duplicate manifests unless forced, and stops after dispose', async () => {
    const t = setup();
    t.q.adopt(meta('r', 0));
    t.q.syncManifest();
    t.q.syncManifest();
    expect(t.manifests).toHaveLength(1);
    t.q.syncManifest(true);
    expect(t.manifests).toHaveLength(2);
    t.q.dispose();
    t.q.add(meta('x', 0), blob());
    t.q.syncManifest(true);
    expect(t.manifests).toHaveLength(2);
    await expect(t.q.whenIdle()).resolves.toBeUndefined();
  });
});

describe('restorable', () => {
  it('keeps only uploaded manifest entries, sorted by start', () => {
    const r = restorable([meta('b', 900), meta('lost', 10), meta('a', 100)], ['a', 'b']);
    expect(r.keep.map((c) => c.id)).toEqual(['a', 'b']);
    expect(r.lost).toBe(1);
  });
});

describe('UploadQueue effects (#48)', () => {
  it('setFx updates the take in the manifest and resends it; none drops the field', async () => {
    const t = setup();
    t.q.add(meta('a', 500), blob());
    await t.q.whenIdle();
    const n = t.manifests.length;
    t.q.setFx('a', 'robot');
    expect(t.manifests.length).toBe(n + 1);
    expect(t.q.manifest()[0]!.fx).toBe('robot');
    t.q.setFx('a', 'robot'); // unchanged → not resent
    expect(t.manifests.length).toBe(n + 1);
    t.q.setFx('a', 'none');
    expect(t.q.manifest()[0]).not.toHaveProperty('fx');
    t.q.setFx('missing', 'ghost');
    expect(t.manifests.length).toBe(n + 2);
  });
});
