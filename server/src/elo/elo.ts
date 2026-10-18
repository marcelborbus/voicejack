/**
 * Pairwise multiplayer Elo (V09), pure.
 *
 * A game of n rated players is scored as n(n−1)/2 one-on-one matches between every pair:
 * the better place wins (S = 1), the worse loses (S = 0), a shared place is a draw (S = ½).
 * With the usual expectation E(i, j) = 1 / (1 + 10^((R_j − R_i) / 400)) and K = 32 / (n − 1),
 *
 *   Δ_i = round( K · Σ_{j≠i} (S_ij − E_ij) )
 *
 * so a player's change stays within ±32 however many opponents there are, and the unrounded
 * changes sum to exactly zero (each pair's S and E are symmetric). Rounding can leave the
 * rounded sum a few points off zero.
 */

export const ELO_K_TOTAL = 32;

export interface EloInput {
  id: string;
  rating: number;
  /** 1-based; equal places are a draw. */
  place: number;
}

export interface EloChange {
  id: string;
  before: number;
  after: number;
  delta: number;
}

/** K per pairing for `n` rated players (0 when there is nobody to play against). */
export function eloK(n: number): number {
  return n < 2 ? 0 : ELO_K_TOTAL / (n - 1);
}

/** Expected score of a player rated `ra` against one rated `rb`. */
export function expectedScore(ra: number, rb: number): number {
  return 1 / (1 + 10 ** ((rb - ra) / 400));
}

/** Unrounded rating changes, in input order. */
export function rawEloDeltas(players: readonly EloInput[]): number[] {
  const k = eloK(players.length);
  return players.map((a, i) => {
    let sum = 0;
    players.forEach((b, j) => {
      if (i === j) return;
      const s = a.place < b.place ? 1 : a.place > b.place ? 0 : 0.5;
      sum += s - expectedScore(a.rating, b.rating);
    });
    return k * sum;
  });
}

/** Rating changes (integers), in input order. */
export function pairwiseElo(players: readonly EloInput[]): EloChange[] {
  const raw = rawEloDeltas(players);
  return players.map((p, i) => {
    const delta = Math.round(raw[i]!) || 0; // no -0
    return { id: p.id, before: p.rating, after: p.rating + delta, delta };
  });
}

/**
 * Competition places ("1, 1, 3") from final totals: more points first, then more round wins
 * (the same order and tie rule as the Final standings / shared victory).
 */
export function placesOf(rows: readonly { total: number; roundWins: number }[]): number[] {
  return rows.map(
    (r) =>
      1 +
      rows.filter((o) => o.total > r.total || (o.total === r.total && o.roundWins > r.roundWins))
        .length,
  );
}
