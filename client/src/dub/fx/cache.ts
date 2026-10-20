// #48: processed takes, cached by (chunk id, effect). A render is reused while the dry buffer
// and its placement (offset/duration) are the same; anything else re-renders. Bounded by
// bytes (LRU), and at most two renders run at once so a showcase full of effects doesn't
// spin up a dozen offline contexts together.
import type { FxEffectId, FxId } from '@dub/shared';
import type { FxSource, ProcessedAudio } from './render';

export interface FxChunkRef {
  id: string;
  offsetMs: number;
  durationMs: number;
  fx?: FxId;
}

export type FxRenderFn = (src: FxSource, fx: FxEffectId) => Promise<ProcessedAudio>;

interface Entry {
  dry: AudioBuffer;
  offsetMs: number;
  durationMs: number;
  promise: Promise<ProcessedAudio>;
  result: ProcessedAudio | null;
  bytes: number;
}

export interface FxCacheOptions {
  render: FxRenderFn;
  maxBytes?: number;
  concurrency?: number;
}

export class FxCache {
  private readonly entries = new Map<string, Entry>();
  private readonly render: FxRenderFn;
  private readonly maxBytes: number;
  private readonly concurrency: number;
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  /** Renders started (tests, debug). */
  renders = 0;

  constructor(o: FxCacheOptions) {
    this.render = o.render;
    this.maxBytes = o.maxBytes ?? 64 * 1024 * 1024;
    this.concurrency = o.concurrency ?? 2;
  }

  private static key(id: string, fx: FxEffectId) {
    return `${id}|${fx}`;
  }

  private valid(e: Entry, c: FxChunkRef, dry: AudioBuffer) {
    return e.dry === dry && e.offsetMs === c.offsetMs && e.durationMs === c.durationMs;
  }

  /** The finished render for `c` (with `c.fx`), or null (dry, not rendered yet, or stale). */
  peek(c: FxChunkRef, dry: AudioBuffer): ProcessedAudio | null {
    const fx = c.fx;
    if (!fx || fx === 'none') return null;
    const e = this.entries.get(FxCache.key(c.id, fx));
    return e && this.valid(e, c, dry) ? e.result : null;
  }

  /** Render (or reuse) `c` with its effect. Null for a dry take. */
  get(c: FxChunkRef, dry: AudioBuffer): Promise<ProcessedAudio> | null {
    const fx = c.fx;
    if (!fx || fx === 'none') return null;
    const key = FxCache.key(c.id, fx);
    const hit = this.entries.get(key);
    if (hit && this.valid(hit, c, dry)) {
      this.entries.delete(key);
      this.entries.set(key, hit); // LRU touch
      return hit.promise;
    }
    const entry: Entry = {
      dry,
      offsetMs: c.offsetMs,
      durationMs: c.durationMs,
      promise: null!,
      result: null,
      bytes: 0,
    };
    entry.promise = this.limit(() =>
      this.render({ buffer: dry, offsetMs: c.offsetMs, durationMs: c.durationMs, seed: c.id }, fx),
    ).then(
      (r) => {
        entry.result = r;
        entry.bytes = r.buffer.length * r.buffer.numberOfChannels * 4;
        this.evict(key);
        return r;
      },
      (e: unknown) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw e;
      },
    );
    this.entries.set(key, entry);
    return entry.promise;
  }

  /** Forget every render of a take (deleted / re-recorded). */
  drop(id: string): void {
    for (const k of [...this.entries.keys()]) if (k.startsWith(`${id}|`)) this.entries.delete(k);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Finished renders, oldest first (debug hook). */
  list(): { chunkId: string; result: ProcessedAudio; dry: AudioBuffer }[] {
    const out: { chunkId: string; result: ProcessedAudio; dry: AudioBuffer }[] = [];
    for (const [k, e] of this.entries)
      if (e.result) out.push({ chunkId: k.split('|')[0]!, result: e.result, dry: e.dry });
    return out;
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(keep: string) {
    let total = 0;
    for (const e of this.entries.values()) total += e.bytes;
    for (const [k, e] of this.entries) {
      if (total <= this.maxBytes) break;
      if (k === keep || !e.result) continue;
      total -= e.bytes;
      this.entries.delete(k);
    }
  }

  private async limit<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}
