import type { ClipInfo, RoundResultEntry } from '@dub/shared';
import { Crown, Film, HelpCircle, MicOff, Star } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PlayerAvatar } from '@/components/PlayerAvatar';
import { seenItem } from '@/components/showcase/showcaseHistory';
import { cn } from '@/lib/utils';
import { CountUp } from './motion';

/**
 * Reveals one dub after another, from last place to first: each card starts as "Dub #k ???"
 * and flips over to the author, the average and the points. Empty submissions are listed
 * (already revealed) at the bottom.
 */
export function RevealList({
  entries,
  code,
  round,
  youId,
  stepMs = 750,
}: {
  entries: RoundResultEntry[];
  code: string;
  round: number;
  youId: string;
  stepMs?: number;
}) {
  const shown = entries.filter((e) => !e.empty);
  const empty = entries.filter((e) => e.empty);
  const [revealed, setRevealed] = useState(0); // how many of `shown`, counted from the bottom
  const topPoints = shown[0]?.points ?? -1;

  useEffect(() => {
    if (revealed >= shown.length) return;
    const t = setTimeout(() => setRevealed((r) => r + 1), revealed === 0 ? 500 : stepMs);
    return () => clearTimeout(t);
  }, [revealed, shown.length, stepMs]);

  return (
    <ol className="flex flex-col gap-2.5" data-testid="results-list" data-revealed={revealed}>
      {shown.map((e, i) => {
        const isRevealed = i >= shown.length - revealed;
        const seen = seenItem(code, round, e.submissionId);
        const winner = e.points === topPoints && topPoints > 0;
        return (
          <li key={e.submissionId} data-testid="result-entry" data-revealed={isRevealed}>
            {isRevealed ? (
              <RevealedRow
                entry={e}
                rank={i + 1}
                winner={winner}
                isYou={e.playerId === youId}
                dubNo={seen ? seen.index + 1 : null}
                myVote={seen?.myVote ?? null}
              />
            ) : (
              <HiddenRow rank={i + 1} dubNo={seen ? seen.index + 1 : null} clip={e.clip} />
            )}
          </li>
        );
      })}
      {empty.map((e) => (
        <li
          key={e.submissionId}
          data-testid="result-entry"
          data-revealed
          className="flex items-center gap-3 rounded-2xl border border-dashed border-white/10 px-4 py-3 text-zinc-500"
        >
          <PlayerAvatar name={e.name} seed={e.playerId} size="sm" dimmed />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-semibold text-zinc-400">{e.name}</span>
            {e.playerId === youId && ' (you)'}
            <span className="block truncate text-xs" data-testid="result-clip">
              {e.clip.title}
            </span>
          </span>
          <span className="flex items-center gap-1.5 text-xs">
            <MicOff className="size-3.5" /> no dub · 0 pts
          </span>
        </li>
      ))}
    </ol>
  );
}

/** V14: every dub has its own clip; a small poster + title says which one. */
function ClipTag({ clip }: { clip: ClipInfo }) {
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 text-zinc-400"
      data-testid="result-clip"
      title={clip.title}
    >
      {clip.posterUrl ? (
        <img
          src={clip.posterUrl}
          alt=""
          className="h-4 w-7 shrink-0 rounded-sm border border-white/10 object-cover"
        />
      ) : (
        <Film className="size-3.5 shrink-0" />
      )}
      <span className="truncate">{clip.title}</span>
    </span>
  );
}

function HiddenRow({ rank, dubNo, clip }: { rank: number; dubNo: number | null; clip: ClipInfo }) {
  return (
    <div className="flex items-center gap-3 rounded-3xl border border-white/[0.06] bg-white/[0.02] px-3 py-3.5 sm:gap-4 sm:px-4">
      <span className="w-6 text-center font-display text-lg font-bold text-zinc-600">{rank}</span>
      <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-zinc-800/80 text-zinc-500">
        <HelpCircle className="size-6" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-zinc-400">{dubNo ? `Dub #${dubNo}` : 'A dub'}</p>
        <p className="mt-1 text-xs">
          <ClipTag clip={clip} />
        </p>
      </div>
      <span className="h-8 w-14 animate-pulse rounded-xl bg-zinc-800" />
    </div>
  );
}

function RevealedRow({
  entry,
  rank,
  winner,
  isYou,
  dubNo,
  myVote,
}: {
  entry: RoundResultEntry;
  rank: number;
  winner: boolean;
  isYou: boolean;
  dubNo: number | null;
  myVote: number | null;
}) {
  return (
    <div
      className={cn(
        'dub-flip-in relative flex items-center gap-3 rounded-3xl border px-3 py-3.5 sm:gap-4 sm:px-4',
        winner
          ? 'dub-glow border-amber-400/40 bg-gradient-to-r from-amber-400/[0.12] via-orange-400/[0.06] to-transparent'
          : 'border-white/[0.08] bg-white/[0.035]',
        isYou && !winner && 'border-fuchsia-400/30',
      )}
    >
      <span
        className={cn(
          'w-6 text-center font-display text-lg font-bold',
          winner ? 'text-amber-300' : 'text-zinc-500',
        )}
      >
        {rank}
      </span>
      <div className="relative">
        <PlayerAvatar name={entry.name} seed={entry.playerId} />
        {winner && (
          <span className="absolute -right-2 -top-2.5 inline-flex size-6 rotate-12 items-center justify-center rounded-full bg-amber-400 shadow-md shadow-amber-500/40 ring-2 ring-zinc-900">
            <Crown className="size-3.5 text-amber-950" strokeWidth={2.5} />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2">
          <span className="truncate font-display text-lg font-bold" data-testid="result-name">
            {entry.name}
          </span>
          {isYou && (
            <span className="shrink-0 rounded-md bg-fuchsia-500/15 px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-fuchsia-200">
              you
            </span>
          )}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-zinc-400">
          <ClipTag clip={entry.clip} />
          {dubNo && <span>Dub #{dubNo}</span>}
          <span className="flex items-center gap-1">
            <Star className="size-3.5 fill-amber-300/80 text-amber-300" />
            {entry.avg === null ? '–' : entry.avg.toFixed(1)}
            <span className="text-zinc-500">
              {' '}
              · {entry.votes} vote{entry.votes === 1 ? '' : 's'}
            </span>
          </span>
          {myVote !== null && <span className="text-zinc-500">you gave {myVote}</span>}
          {entry.avg === null && <span className="text-zinc-500">no votes: neutral 50</span>}
        </p>
      </div>
      <div className="text-right">
        <p
          className={cn(
            'font-display text-2xl font-extrabold leading-none sm:text-3xl',
            winner ? 'text-brand' : 'text-zinc-100',
          )}
          data-testid="result-points"
        >
          <CountUp to={entry.points} ms={800} prefix="+" />
        </p>
        <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          points
        </p>
      </div>
    </div>
  );
}
