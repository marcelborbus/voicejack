import type { PlayerId } from '../protocol/common.js';
import { shuffle, type Rng } from './rng.js';

/**
 * Which clips a room has dealt so far (V14). Kept by the Room for its whole life, across
 * `backToLobby`, so clips do not repeat in a room while there are fresh ones.
 */
export interface ClipHistory {
  /** Clip id → deal number of the round it was last dealt in (higher = more recent). */
  lastUsed: Map<string, number>;
  /** Player id → clip ids that player has already been dealt. */
  seen: Map<PlayerId, Set<string>>;
  /** Deal counter; `recordClips` bumps it. */
  deals: number;
}

export function emptyClipHistory(): ClipHistory {
  return { lastUsed: new Map(), seen: new Map(), deals: 0 };
}

/** Writes one round's assignment into the history. */
export function recordClips(
  history: ClipHistory,
  assignment: ReadonlyMap<PlayerId, { id: string }>,
): void {
  history.deals += 1;
  for (const [playerId, clip] of assignment) {
    history.lastUsed.set(clip.id, history.deals);
    let s = history.seen.get(playerId);
    if (!s) history.seen.set(playerId, (s = new Set()));
    s.add(clip.id);
  }
}

/**
 * Deals one clip per player for a round (V14: every player dubs a different scene).
 *
 * Rules, in order of strength:
 * 1. Clips are distinct within the round (always, as long as `library.length >= players`).
 * 2. No player gets a clip they already had. Maximised by bipartite matching: as many players
 *    as possible get a clip that is new to them.
 * 3. Clips nobody in the room has had yet are preferred; after that, the least recently used
 *    ones (ties broken at random).
 *
 * Last resorts (documented, both should be prevented by the caller):
 * - A player who cannot get a clip new to them (the library is too small for the history)
 *   gets a repeat, still distinct within the round, least recently used first.
 * - With fewer clips than players, clips repeat within the round (the Room's start blocker
 *   stops this case for private rooms).
 *
 * Returns `null` only for an empty library with at least one player.
 */
export function assignClips<T extends { id: string }>(
  players: readonly PlayerId[],
  library: readonly T[],
  history: Pick<ClipHistory, 'lastUsed' | 'seen'>,
  rng: Rng = Math.random,
): Map<PlayerId, T> | null {
  const out = new Map<PlayerId, T>();
  if (players.length === 0) return out;
  if (library.length === 0) return null;

  // Priority: never used first (random order), then least recently used.
  const age = (c: T) => history.lastUsed.get(c.id) ?? -Infinity;
  const ranked = shuffle(library, rng).sort((a, b) => age(a) - age(b));
  const order = shuffle(players, rng);
  const had = (p: PlayerId, c: T) => history.seen.get(p)?.has(c.id) ?? false;

  // Kuhn's augmenting paths, clips in priority order: the set of matched clips only grows, so
  // the result is the best-priority clip set among all maximum "new to everyone" matchings.
  const owner = new Map<PlayerId, T>();
  const tryClip = (c: T, visited: Set<PlayerId>): boolean => {
    for (const p of order) {
      if (visited.has(p) || had(p, c)) continue;
      visited.add(p);
      const prev = owner.get(p);
      if (prev === undefined || tryClip(prev, visited)) {
        owner.set(p, c);
        return true;
      }
    }
    return false;
  };
  for (const c of ranked) {
    if (owner.size === order.length) break;
    tryClip(c, new Set());
  }

  // Last resort 1: repeats for whoever is left, still distinct within the round.
  const taken = new Set([...owner.values()].map((c) => c.id));
  const free = ranked.filter((c) => !taken.has(c.id));
  for (const p of order) {
    if (owner.has(p)) continue;
    const c = free.shift();
    if (c) owner.set(p, c);
  }
  // Last resort 2: fewer clips than players, so clips repeat within the round.
  let i = 0;
  for (const p of order) {
    if (!owner.has(p)) owner.set(p, ranked[i++ % ranked.length]!);
  }

  for (const p of players) out.set(p, owner.get(p)!);
  return out;
}
