import type { ChunkMeta, Limits } from '../protocol/common.js';

/** A chunk may run this far past the clip end (recorder stop latency). */
export const MANIFEST_END_TOLERANCE_MS = 1000;

export type ManifestCheck = { ok: true; chunks: ChunkMeta[] } | { ok: false; reason: string };

/**
 * Semantic manifest checks beyond the zod shape: count, unique ids, per-chunk and total byte
 * limits, minimum length, and placement inside the clip. On success returns chunks sorted by
 * `startMs` (then id).
 */
export function validateManifest(
  chunks: readonly ChunkMeta[],
  clipDurationMs: number,
  limits: Limits,
): ManifestCheck {
  if (chunks.length > limits.maxChunksPerSubmission) {
    return { ok: false, reason: `too many chunks (max ${limits.maxChunksPerSubmission})` };
  }
  const ids = new Set<string>();
  let total = 0;
  for (const c of chunks) {
    if (ids.has(c.id)) return { ok: false, reason: `duplicate chunk id ${c.id}` };
    ids.add(c.id);
    if (c.bytes > limits.maxChunkBytes) return { ok: false, reason: `chunk ${c.id} too large` };
    total += c.bytes;
    if (c.durationMs < limits.minChunkMs) return { ok: false, reason: `chunk ${c.id} too short` };
    if (c.startMs < 0 || c.startMs >= clipDurationMs) {
      return { ok: false, reason: `chunk ${c.id} starts outside the clip` };
    }
    if (c.startMs + c.durationMs > clipDurationMs + MANIFEST_END_TOLERANCE_MS) {
      return { ok: false, reason: `chunk ${c.id} runs past the clip end` };
    }
  }
  if (total > limits.maxSubmissionBytes) return { ok: false, reason: 'submission too large' };
  const sorted = chunks
    .slice()
    .sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ok: true, chunks: sorted };
}
