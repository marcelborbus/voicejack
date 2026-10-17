import type { PlayerPublic, RoundResultEntry } from '@dub/shared';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { PlayerAvatar } from '@/components/PlayerAvatar';
import { cn } from '@/lib/utils';
import { CountUp } from './motion';

export interface StandingRow {
  playerId: string;
  name: string;
  total: number;
  delta: number;
  rank: number;
  prevRank: number;
}

/** Ranks with ties sharing a rank ("1, 1, 3"). */
function ranks<T>(rows: T[], score: (r: T) => number): Map<T, number> {
  const sorted = [...rows].sort((a, b) => score(b) - score(a));
  const out = new Map<T, number>();
  sorted.forEach((r, i) => {
    const prev = sorted[i - 1];
    out.set(r, prev && score(prev) === score(r) ? out.get(prev)! : i + 1);
  });
  return out;
}

/** Totals after this round, the round's delta, and how the rank moved. Pure. */
export function buildStandings(players: PlayerPublic[], entries: RoundResultEntry[]): StandingRow[] {
  const delta = new Map(entries.map((e) => [e.playerId, e.points]));
  const rows = players.map((p) => ({
    playerId: p.id,
    name: p.name,
    total: p.totalScore,
    delta: delta.get(p.id) ?? 0,
  }));
  const now = ranks(rows, (r) => r.total);
  const before = ranks(rows, (r) => r.total - r.delta);
  return rows
    .map((r) => ({ ...r, rank: now.get(r)!, prevRank: before.get(r)! }))
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}

export function Leaderboard({
  rows,
  youId,
  start = true,
}: {
  rows: StandingRow[];
  youId: string;
  start?: boolean;
}) {
  return (
    <ol className="flex flex-col gap-2" data-testid="leaderboard">
      {rows.map((r, i) => {
        const moved = r.prevRank - r.rank;
        return (
          <li
            key={r.playerId}
            style={{ animationDelay: `${i * 60}ms` }}
            className={cn(
              'flex animate-fade-up items-center gap-3 rounded-2xl px-3 py-2.5',
              r.playerId === youId ? 'bg-fuchsia-500/[0.08] ring-1 ring-fuchsia-400/25' : 'bg-white/[0.025]',
            )}
          >
            <span className="w-5 text-center font-display font-bold text-zinc-400">{r.rank}</span>
            <PlayerAvatar name={r.name} seed={r.playerId} size="sm" />
            <span className="min-w-0 flex-1 truncate font-semibold">{r.name}</span>
            <span
              title={moved > 0 ? `Up ${moved}` : moved < 0 ? `Down ${-moved}` : 'No change'}
              className={cn(
                'inline-flex items-center text-xs font-semibold',
                moved > 0 && 'text-emerald-300',
                moved < 0 && 'text-rose-300',
                moved === 0 && 'text-zinc-600',
              )}
            >
              {moved > 0 ? <ArrowUp className="size-3.5" /> : moved < 0 ? <ArrowDown className="size-3.5" /> : <Minus className="size-3.5" />}
              {moved !== 0 && Math.abs(moved)}
            </span>
            {r.delta > 0 && (
              <span className="rounded-lg bg-emerald-400/10 px-1.5 py-0.5 text-xs font-bold tabular-nums text-emerald-300">
                +{r.delta}
              </span>
            )}
            <span className="w-14 text-right font-display text-xl font-extrabold">
              <CountUp from={r.total - r.delta} to={r.total} start={start} ms={1100} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}
