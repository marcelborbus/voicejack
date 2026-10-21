/**
 * #53: clips played in memory. A showcase/final clip (≤ 60 s, a few MB) is fetched completely into
 * a Blob and played from an object URL, so the network can never stall playback mid-dub; the
 * next item's clip is fetched ahead. Entries are refcounted while a video uses them and the
 * least recently used unpinned ones are released beyond `MAX_ENTRIES`.
 */

interface Entry {
  promise: Promise<string>;
  objectUrl: string | null;
  pins: number;
  usedAt: number;
}

const MAX_ENTRIES = 4;
const entries = new Map<string, Entry>();
let tick = 0;

export interface ClipCacheDeps {
  fetch: (url: string) => Promise<Blob>;
  createObjectURL: (b: Blob) => string;
  revokeObjectURL: (u: string) => void;
}

let deps: ClipCacheDeps = {
  fetch: async (url) => {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.blob();
  },
  createObjectURL: (b) => URL.createObjectURL(b),
  revokeObjectURL: (u) => URL.revokeObjectURL(u),
};

/** Test hook. */
export function setClipCacheDeps(d: Partial<ClipCacheDeps>): void {
  deps = { ...deps, ...d };
  clearClipCache();
}

export function clearClipCache(): void {
  for (const e of entries.values()) if (e.objectUrl) deps.revokeObjectURL(e.objectUrl);
  entries.clear();
}

function load(url: string): Entry {
  let e = entries.get(url);
  if (!e) {
    const entry: Entry = { promise: Promise.resolve(url), objectUrl: null, pins: 0, usedAt: 0 };
    entry.promise = deps.fetch(url).then(
      (blob) => {
        if (entries.get(url) !== entry) return url; // evicted meanwhile
        entry.objectUrl = deps.createObjectURL(blob);
        return entry.objectUrl;
      },
      (err: unknown) => {
        console.warn('[clip] in-memory fetch failed, streaming instead', url, err);
        entries.delete(url); // try again next time
        return url;
      },
    );
    entries.set(url, entry);
    e = entry;
  }
  e.usedAt = ++tick;
  evict();
  return e;
}

function evict(): void {
  if (entries.size <= MAX_ENTRIES) return;
  const free = [...entries]
    .filter(([, e]) => e.pins === 0)
    .sort((a, b) => a[1].usedAt - b[1].usedAt);
  for (const [url, e] of free) {
    if (entries.size <= MAX_ENTRIES) break;
    entries.delete(url);
    if (e.objectUrl) deps.revokeObjectURL(e.objectUrl);
  }
}

/** Starts fetching `url` into memory (the next showcase item). */
export function prefetchClip(url: string): void {
  void load(url).promise;
}

/**
 * The playable URL for `url`: an object URL of the fully downloaded file (or `url` itself if that
 * failed). `release` unpins it once the video moved on.
 */
export function acquireClip(url: string): { src: Promise<string>; release: () => void } {
  const e = load(url);
  e.pins++;
  let released = false;
  return {
    src: e.promise,
    release: () => {
      if (released) return;
      released = true;
      e.pins = Math.max(0, e.pins - 1);
      evict();
    },
  };
}

/** Entries for tests / debugging. */
export function clipCacheSize(): number {
  return entries.size;
}
