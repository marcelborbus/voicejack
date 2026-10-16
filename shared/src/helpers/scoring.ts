import type {
  BestDub,
  ChunkRef,
  ClipInfo,
  FinalResult,
  FinalStanding,
  PlayerId,
  RoundResult,
  RoundResultEntry,
  SubmissionId,
} from '../protocol/common.js';

/** Points a non-empty dub gets when nobody voted on it (neutral, see PLAN §2.2). */
export const NO_VOTE_POINTS = 50;

export interface SubmissionScore {
  avg: number | null;
  votes: number;
  points: number;
}

/** `points = round(mean(votes) * 10)`; zero votes → avg null, 50 points. */
export function scoreSubmission(votes: readonly number[]): SubmissionScore {
  if (votes.length === 0) return { avg: null, votes: 0, points: NO_VOTE_POINTS };
  const avg = votes.reduce((a, b) => a + b, 0) / votes.length;
  return { avg, votes: votes.length, points: Math.round(avg * 10) };
}

export interface SubmissionVotes {
  submissionId: SubmissionId;
  playerId: PlayerId;
  name: string;
  /** No chunks → 0 points, not showcased. */
  empty: boolean;
  votes: readonly number[];
}

/** Scores every submission; entries sorted by points desc (stable for ties, empties last). */
export function buildRoundResult(
  round: number,
  clip: ClipInfo,
  subs: readonly SubmissionVotes[],
): RoundResult {
  const entries: RoundResultEntry[] = subs.map((s) => {
    if (s.empty) {
      return {
        submissionId: s.submissionId,
        playerId: s.playerId,
        name: s.name,
        avg: null,
        votes: 0,
        points: 0,
        empty: true,
      };
    }
    const sc = scoreSubmission(s.votes);
    return {
      submissionId: s.submissionId,
      playerId: s.playerId,
      name: s.name,
      ...sc,
      empty: false,
    };
  });
  entries.sort((a, b) => b.points - a.points || Number(a.empty) - Number(b.empty));
  return { round, clip, entries };
}

/** Player ids holding the highest points of a round (non-empty, > 0 points). Ties all win. */
export function roundWinners(result: RoundResult): PlayerId[] {
  const valid = result.entries.filter((e) => !e.empty && e.points > 0);
  if (valid.length === 0) return [];
  const max = Math.max(...valid.map((e) => e.points));
  return valid.filter((e) => e.points === max).map((e) => e.playerId);
}

export interface FinalPlayer {
  playerId: PlayerId;
  name: string;
}

/**
 * Standings by total desc, then round wins desc, then the given player order (join order).
 * Winners = everyone tied with the leader on (total, roundWins). `bestDub` = the first
 * winner's highest-points non-empty submission (later round on tie).
 */
export function buildFinal(
  players: readonly FinalPlayer[],
  rounds: readonly RoundResult[],
  chunksOf: (round: number, submissionId: SubmissionId) => ChunkRef[],
): FinalResult {
  const totals = new Map<PlayerId, { total: number; roundWins: number }>();
  for (const p of players) totals.set(p.playerId, { total: 0, roundWins: 0 });
  for (const r of rounds) {
    for (const e of r.entries) {
      const t = totals.get(e.playerId);
      if (t) t.total += e.points;
    }
    for (const w of roundWinners(r)) {
      const t = totals.get(w);
      if (t) t.roundWins += 1;
    }
  }
  const order = new Map(players.map((p, i) => [p.playerId, i]));
  const standings: FinalStanding[] = players
    .map((p) => ({ playerId: p.playerId, name: p.name, ...totals.get(p.playerId)! }))
    .sort(
      (a, b) =>
        b.total - a.total ||
        b.roundWins - a.roundWins ||
        order.get(a.playerId)! - order.get(b.playerId)!,
    );
  const lead = standings[0];
  const winners = lead
    ? standings
        .filter((s) => s.total === lead.total && s.roundWins === lead.roundWins)
        .map((s) => s.playerId)
    : [];

  let bestDub: BestDub | null = null;
  const first = winners[0];
  if (first !== undefined) {
    for (const r of rounds) {
      for (const e of r.entries) {
        if (e.playerId !== first || e.empty) continue;
        if (!bestDub || e.points >= bestDub.points) {
          bestDub = {
            round: r.round,
            clip: r.clip,
            submissionId: e.submissionId,
            playerId: e.playerId,
            chunks: [],
            points: e.points,
          };
        }
      }
    }
    if (bestDub) bestDub.chunks = chunksOf(bestDub.round, bestDub.submissionId);
  }
  return { winners, standings, bestDub };
}
