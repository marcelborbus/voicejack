import { randInt, type Rng } from './rng.js';

export interface TaggedClip {
  id: string;
  tags: readonly string[];
}

/** Clips matching any of `tags` (`[]` = all) that are not in `used`. */
export function filterClips<T extends TaggedClip>(
  library: readonly T[],
  tags: readonly string[],
  used: Iterable<string>,
): T[] {
  const usedSet = used instanceof Set ? (used as Set<string>) : new Set(used);
  return library.filter(
    (c) => !usedSet.has(c.id) && (tags.length === 0 || c.tags.some((t) => tags.includes(t))),
  );
}

export function availableClipCount(
  library: readonly TaggedClip[],
  tags: readonly string[],
  used: Iterable<string>,
): number {
  return filterClips(library, tags, used).length;
}

/** Random available clip, or `null` when none is left. */
export function pickClip<T extends TaggedClip>(
  library: readonly T[],
  tags: readonly string[],
  used: Iterable<string>,
  rng: Rng = Math.random,
): T | null {
  const pool = filterClips(library, tags, used);
  if (pool.length === 0) return null;
  return pool[randInt(rng, pool.length)]!;
}

/** Sorted unique tags across the library (for the host's tag picker). */
export function collectTags(library: readonly TaggedClip[]): string[] {
  return [...new Set(library.flatMap((c) => c.tags))].sort();
}
