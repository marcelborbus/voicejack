import type { QueueMode } from '@dub/shared';
import type { MatchContext, MatcherRules, QueueEntry } from './Matcher.js';

/**
 * V09 matching rules (plugged into the V08 Matcher through `compatible` / `score`).
 *
 * - Casual and ranked share one queue but never mix. Casual is V08 as before: everyone fits,
 *   queue order decides.
 * - Ranked, for an anchor who has waited `w`:
 *   - window = 100 + 50 × floor(w / 5 s) Elo; `b` fits if |Δelo| ≤ window;
 *   - after 45 s anyone ranked fits;
 *   - tolerance for a quiet server: after 20 s, if fewer than 3 queued ranked players
 *     (the anchor included) are inside the anchor's window, anyone ranked fits.
 *   Candidates are taken closest Elo first.
 */
export const RANKED_RULES = {
  baseWindow: 100,
  stepWindow: 50,
  stepMs: 5_000,
  anyAfterMs: 45_000,
  toleranceAfterMs: 20_000,
  toleranceMin: 3,
} as const;

export interface RatedEntry extends QueueEntry {
  mode: QueueMode;
  elo: number;
}

/** Ranked Elo window after waiting `waitedMs` (Infinity once anyone fits). */
export function rankedWindow(waitedMs: number): number {
  const r = RANKED_RULES;
  if (waitedMs >= r.anyAfterMs) return Infinity;
  return r.baseWindow + r.stepWindow * Math.floor(Math.max(0, waitedMs) / r.stepMs);
}

export function rankedCompatible<T extends RatedEntry>(
  a: T,
  b: T,
  waitedMs: number,
  ctx: MatchContext<T>,
): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode !== 'ranked') return true;
  const w = rankedWindow(waitedMs);
  if (Math.abs(a.elo - b.elo) <= w) return true;
  if (waitedMs < RANKED_RULES.toleranceAfterMs) return false;
  let inside = 0;
  for (const e of ctx.queue) {
    if (e.mode === 'ranked' && Math.abs(e.elo - a.elo) <= w) inside++;
  }
  return inside < RANKED_RULES.toleranceMin;
}

/** Closest Elo first in ranked; no preference in casual (queue order). */
export function rankedScore<T extends RatedEntry>(a: T, b: T): number {
  return a.mode === 'ranked' ? -Math.abs(a.elo - b.elo) : 0;
}

export function eloMatchRules<T extends RatedEntry>(): Pick<
  MatcherRules<T>,
  'compatible' | 'score'
> {
  return { compatible: rankedCompatible, score: rankedScore };
}
