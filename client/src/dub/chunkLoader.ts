import { PLAYER_TOKEN_HEADER, type ChunkMeta } from '@dub/shared';
import { toast } from '@/lib/toast';
import type { AudioBufferLike } from './types';

/** Waveform resolution: one peak per 10 ms of buffer audio. */
export const PEAKS_PER_SEC = 100;

export interface DecodedAudio {
  buffer: AudioBuffer;
  /** Max |sample| over all channels per 1/PEAKS_PER_SEC s of buffer time, 0..1. */
  peaks: Float32Array;
}

export interface LoadedChunk extends DecodedAudio {
  meta: ChunkMeta;
}

/** Per-bucket absolute peak over all channels. Pure (works on any AudioBuffer-like). */
export function computePeaks(
  buffer: Pick<AudioBufferLike, 'length' | 'sampleRate' | 'numberOfChannels' | 'getChannelData'>,
  peaksPerSec = PEAKS_PER_SEC,
): Float32Array {
  const per = Math.max(1, Math.round(buffer.sampleRate / peaksPerSec));
  const n = Math.ceil(buffer.length / per);
  const out = new Float32Array(n);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let b = 0; b < n; b++) {
      let max = out[b]!;
      const end = Math.min(data.length, (b + 1) * per);
      for (let i = b * per; i < end; i++) {
        const v = data[i]!;
        const a = v < 0 ? -v : v;
        if (a > max) max = a;
      }
      out[b] = max > 1 ? 1 : max;
    }
  }
  return out;
}

/** `decodeAudioData` with the promise form (and the callback form for old Safari). */
export function decodeAudio(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(data, resolve, (e) => reject(e ?? new Error('decode failed')));
    p?.catch?.(reject);
  });
}

export async function decodeWithPeaks(
  ctx: BaseAudioContext,
  data: ArrayBuffer,
): Promise<DecodedAudio> {
  const buffer = await decodeAudio(ctx, data);
  return { buffer, peaks: computePeaks(buffer) };
}

export interface FetchOptions {
  token?: string | null;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/** GET a chunk's bytes with the player token. Throws on HTTP errors. */
export async function fetchChunkBytes(url: string, opts: FetchOptions = {}): Promise<ArrayBuffer> {
  const f = opts.fetch ?? fetch;
  const headers: Record<string, string> = {};
  if (opts.token) headers[PLAYER_TOKEN_HEADER] = opts.token;
  const res = await f(url, { headers, signal: opts.signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`chunk download failed (${res.status})`);
  return res.arrayBuffer();
}

// Decoded chunks are kept across phases (showcase → final replay → render) in a small
// size-bounded LRU keyed by URL. Chunk URLs are unique per submission + chunk id.
const CACHE_MAX_BYTES = 96 * 1024 * 1024;
const cache = new Map<string, { p: Promise<DecodedAudio>; bytes: number }>();

function cacheBytes(): number {
  let n = 0;
  for (const e of cache.values()) n += e.bytes;
  return n;
}

function cachePut(url: string, p: Promise<DecodedAudio>) {
  const entry = { p, bytes: 0 };
  cache.set(url, entry);
  p.then(
    (d) => {
      entry.bytes = d.buffer.length * d.buffer.numberOfChannels * 4;
      while (cacheBytes() > CACHE_MAX_BYTES && cache.size > 1) {
        const oldest = cache.keys().next().value!;
        if (oldest === url) break;
        cache.delete(oldest);
      }
    },
    () => {
      if (cache.get(url) === entry) cache.delete(url);
    },
  );
}

/** Rejects with an AbortError when `signal` aborts; otherwise settles like `p`. */
function withSignal<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Download + decode (cached by URL). The shared download itself is never aborted: the
 * caller's `signal` only detaches that caller, so an aborted load can't leave a rejected
 * promise in the cache for the next caller. Failed loads are dropped from the cache.
 */
export function loadChunkAudio(
  ctx: BaseAudioContext,
  url: string,
  opts: FetchOptions = {},
): Promise<DecodedAudio> {
  const hit = cache.get(url);
  if (hit) {
    cache.delete(url);
    cache.set(url, hit); // LRU touch
    return withSignal(hit.p, opts.signal);
  }
  const p = fetchChunkBytes(url, { ...opts, signal: undefined }).then((bytes) =>
    decodeWithPeaks(ctx, bytes),
  );
  cachePut(url, p);
  return withSignal(p, opts.signal);
}

/** Seed the cache with audio we already have (own recordings, so showcase needn't refetch). */
export function primeChunkCache(url: string, audio: DecodedAudio): void {
  cachePut(url, Promise.resolve(audio));
}

export function clearChunkCache(): void {
  cache.clear();
}

/**
 * Loads a whole submission. Chunks that fail to download or decode are skipped with one
 * toast; the rest still play (§5 codec risk).
 */
export async function loadChunks(
  ctx: BaseAudioContext,
  refs: readonly (ChunkMeta & { url: string })[],
  opts: FetchOptions & { quiet?: boolean } = {},
): Promise<LoadedChunk[]> {
  const results = await Promise.allSettled(refs.map((r) => loadChunkAudio(ctx, r.url, opts)));
  const out: LoadedChunk[] = [];
  let failed = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out.push({ meta: refs[i]!, ...r.value });
    else failed++;
  });
  if (failed > 0 && !opts.quiet && !opts.signal?.aborted) {
    toast(failed === 1 ? 'One audio chunk could not be played' : `${failed} audio chunks could not be played`, {
      variant: 'warning',
      description: 'It was skipped. The rest of the dub plays normally.',
    });
  }
  return out;
}
