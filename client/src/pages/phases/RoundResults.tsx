import { formatClock } from '@dub/shared';
import { ArrowRight, Flag, Trophy } from 'lucide-react';
import { useMemo, useRef } from 'react';
import { buildStandings, Leaderboard } from '@/components/results/Leaderboard';
import { RevealList } from '@/components/results/RevealList';
import { ClipAttribution } from '@/components/showcase/ClipAttribution';
import { useServerNow } from '@/components/showcase/useServerNow';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useIsHost, useSnapshot } from '@/state/room';
import { send } from '@/state/session';

export function RoundResults() {
  const snap = useSnapshot();
  const isHost = useIsHost();
  const result = snap?.roundResult ?? null;
  const standings = useMemo(
    () => (snap && result ? buildStandings(snap.players, result.entries) : []),
    [snap, result],
  );
  if (!snap || !result) return null;

  const isLast = snap.round + 1 >= snap.totalRounds;
  const shownCount = result.entries.filter((e) => !e.empty).length;
  const youId = snap.you.playerId;

  return (
    <div className="flex flex-col gap-5" data-testid="round-results">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
            <Flag className="size-3.5" /> Round {result.round + 1} of {snap.totalRounds} ·{' '}
            {result.clip.title}
          </p>
          <h2 className="mt-1 font-display text-4xl font-extrabold tracking-tight sm:text-5xl">
            The votes are <span className="text-brand">in</span>
          </h2>
        </div>
        <AdvanceBar
          isHost={isHost}
          isLast={isLast}
          endsAt={snap.phaseEndsAt}
        />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Who dubbed what</CardTitle>
            <p className="text-sm text-zinc-400">
              {shownCount === 0
                ? 'Nobody recorded anything this round.'
                : 'Points = average score × 10. A dub without votes gets a neutral 50.'}
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <RevealList
              entries={result.entries}
              code={snap.code}
              round={result.round}
              youId={youId}
            />
            <ClipAttribution clip={result.clip} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Trophy className="size-5 text-amber-300" /> Leaderboard
            </CardTitle>
            <p className="text-sm text-zinc-400">
              {isLast ? 'Final scores are coming next.' : 'Totals after this round.'}
            </p>
          </CardHeader>
          <CardContent>
            <Leaderboard rows={standings} youId={youId} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function AdvanceBar({
  isHost,
  isLast,
  endsAt,
}: {
  isHost: boolean;
  isLast: boolean;
  endsAt: number | null;
}) {
  const now = useServerNow(250, endsAt !== null);
  const left = endsAt === null ? null : Math.max(0, endsAt - now);
  // The full countdown length isn't sent; the first value we see is close enough.
  const total = useRef(0);
  if (left !== null && left > total.current) total.current = left;
  const frac = left !== null && total.current > 0 ? left / total.current : 0;
  const next = isLast ? 'Final results' : 'Next round';
  return (
    <div className="flex items-center gap-3" data-testid="results-countdown">
      {left !== null && (
        <div className="flex flex-col items-end gap-1.5">
          <p className="text-sm text-zinc-400">
            {next} in{' '}
            <span className="font-mono font-semibold tabular-nums text-zinc-100">
              {formatClock(left, 'ceil')}
            </span>
          </p>
          <div className="h-1 w-32 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full origin-right bg-brand transition-transform duration-300 ease-linear"
              style={{ transform: `scaleX(${frac})` }}
            />
          </div>
        </div>
      )}
      {isHost ? (
        <Button data-testid="results-next" onClick={() => send({ t: 'advance' })}>
          {next} <ArrowRight />
        </Button>
      ) : (
        <span className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-zinc-400">
          The host can skip ahead
        </span>
      )}
    </div>
  );
}
