import { TrendingDown, TrendingUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatEloDelta, type GameEloResult } from '@dub/shared';
import { RegisterPrompt } from '@/components/account/RegisterPrompt';
import { CountUp } from '@/components/results/motion';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { loadMe } from '@/state/me';
import { useSnapshot } from '@/state/room';
import { fetchLastGame } from './api';

/**
 * Final, public games only (V09): "Rating 1012 → 1031 (+19)" with a count-up, and for guests
 * the "keep your rating" register prompt. Renders nothing for private rooms.
 */
export function EloResult({ className }: { className?: string }) {
  const snap = useSnapshot();
  const code = snap?.kind === 'public' && snap.phase === 'FINAL' ? snap.code : null;
  const [game, setGame] = useState<GameEloResult | null>(null);

  useEffect(() => {
    if (!code) return;
    let live = true;
    const load = (left: number) =>
      fetchLastGame(code).then(
        (g) => {
          if (!live) return;
          if (g) {
            setGame(g);
            void loadMe(true); // account menu + ranked unlock pick up the new numbers
          } else if (left > 0) setTimeout(() => void load(left - 1), 800);
        },
        () => live && left > 0 && setTimeout(() => void load(left - 1), 1500),
      );
    void load(3);
    return () => {
      live = false;
    };
  }, [code]);

  if (!code) return null;
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {game && <EloChangeCard game={game} />}
      <RegisterPrompt
        text={
          'Your rating lives in this browser for now. Add your email to keep it on any device. ' +
          'Signing in to an account that already has public games keeps that account’s rating instead.'
        }
      />
    </div>
  );
}

function EloChangeCard({ game }: { game: GameEloResult }) {
  const delta = game.eloAfter - game.eloBefore;
  const up = delta > 0;
  const Icon = delta < 0 ? TrendingDown : TrendingUp;
  return (
    <Card data-testid="elo-result" className="animate-fade-up">
      <CardContent className="flex items-center gap-4">
        <Icon
          aria-hidden
          className={cn(
            'size-9 shrink-0',
            up ? 'text-emerald-300' : delta < 0 ? 'text-rose-300' : 'text-zinc-400',
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-zinc-400">
            {game.kind === 'ranked' ? 'Ranked rating' : 'Rating'} · place {game.place} of{' '}
            {game.players}
          </p>
          <p className="font-display text-2xl font-extrabold" data-testid="elo-change">
            <span className="tabular-nums text-zinc-400">{game.eloBefore}</span>
            <span aria-hidden className="px-2 text-zinc-500">
              →
            </span>
            <span className="sr-only"> to </span>
            <CountUp from={game.eloBefore} to={game.eloAfter} ms={1200} />{' '}
            <span
              style={{ animationDelay: '1100ms' }}
              className={cn(
                'inline-block animate-pop text-lg',
                up ? 'text-emerald-300' : delta < 0 ? 'text-rose-300' : 'text-zinc-400',
              )}
            >
              ({formatEloDelta(delta)})
            </span>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
