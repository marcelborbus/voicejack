import { Crown, Medal, MicOff, RotateCcw, Trophy } from 'lucide-react';
import { useState } from 'react';
import { PlayerAvatar } from '@/components/PlayerAvatar';
import { BestDubReplay, useDubChunks } from '@/components/results/BestDubReplay';
import { Confetti, CountUp } from '@/components/results/motion';
import { SaveVideo } from '@/components/results/SaveVideo';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useIsHost, useSnapshot } from '@/state/room';
import { send } from '@/state/session';
import type { FinalResult } from '@dub/shared';

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

export function Final() {
  const snap = useSnapshot();
  const isHost = useIsHost();
  const final = snap?.final ?? null;
  if (!snap || !final) return null;
  const youId = snap.you.playerId;
  const winnerNames = final.standings
    .filter((s) => final.winners.includes(s.playerId))
    .map((s) => s.name);
  const youWon = final.winners.includes(youId);

  return (
    <div className="flex flex-col gap-6" data-testid="final">
      {final.winners.length > 0 && <Confetti />}
      <section className="flex flex-col items-center gap-4 pt-2 text-center">
        <span className="dub-trophy inline-flex size-24 items-center justify-center rounded-[2rem] bg-gradient-to-br from-amber-300 via-orange-400 to-fuchsia-500 shadow-2xl shadow-orange-500/40 ring-1 ring-white/30">
          <Trophy className="size-12 text-white drop-shadow" strokeWidth={2.25} />
        </span>
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-400">
          {final.winners.length > 1 ? 'Shared victory' : 'And the winner is'}
        </p>
        <h2
          data-testid="final-winner"
          className="animate-pop font-display text-5xl font-extrabold tracking-tight sm:text-7xl"
        >
          {winnerNames.length ? (
            <span className="text-brand">{listNames(winnerNames)}</span>
          ) : (
            'Nobody'
          )}
        </h2>
        <p className="text-zinc-400">
          {youWon
            ? 'That was you. Take a bow!'
            : `${snap.totalRounds} round${snap.totalRounds === 1 ? '' : 's'} of questionable voice acting are over.`}
        </p>
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <BestDubCard final={final} />
        <div className="flex flex-col gap-5">
          <Standings final={final} youId={youId} />
          <Card>
            <CardContent className="flex flex-col gap-3">
              {isHost ? (
                <Button
                  size="lg"
                  data-testid="back-to-lobby"
                  onClick={() => send({ t: 'backToLobby' })}
                >
                  <RotateCcw /> Back to lobby
                </Button>
              ) : (
                <p className="text-center text-sm text-zinc-400" data-testid="waiting-for-host">
                  Waiting for the host to start another game…
                </p>
              )}
              <p className="text-center text-xs text-zinc-500">
                Scores reset in the lobby. Clips you've played won't come up again in this room.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function BestDubCard({ final }: { final: FinalResult }) {
  const best = final.bestDub;
  const dub = useDubChunks(best?.chunks ?? []);
  const [pauseSignal, setPauseSignal] = useState(0);
  if (!best) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
          <MicOff className="size-10 text-zinc-500" />
          <p className="font-display text-2xl font-bold">No dubs this game</p>
          <p className="max-w-sm text-sm text-zinc-400">
            Nobody recorded anything, so there's nothing to replay. Next time, hit R and go!
          </p>
        </CardContent>
      </Card>
    );
  }
  const author = final.standings.find((s) => s.playerId === best.playerId)?.name ?? 'The winner';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-baseline gap-x-2">
          The winning dub
          <span className="text-base font-semibold text-zinc-400">
            by {author} · round {best.round + 1} · {best.points} pts
          </span>
        </CardTitle>
        <p className="text-sm text-zinc-400">“{best.clip.title}”</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <BestDubReplay clip={best.clip} dub={dub} pauseSignal={pauseSignal} />
        <SaveVideo
          clip={best.clip}
          dub={dub}
          authorName={author}
          onStart={() => setPauseSignal((n) => n + 1)}
        />
      </CardContent>
    </Card>
  );
}

function Standings({ final, youId }: { final: FinalResult; youId: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Medal className="size-5 text-amber-300" /> Final standings
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-2" data-testid="final-standings">
          {final.standings.map((s, i) => {
            const winner = final.winners.includes(s.playerId);
            return (
              <li
                key={s.playerId}
                style={{ animationDelay: `${200 + i * 90}ms` }}
                className={cn(
                  'flex animate-fade-up items-center gap-3 rounded-2xl px-3 py-2.5',
                  winner
                    ? 'dub-glow bg-gradient-to-r from-amber-400/[0.12] to-transparent'
                    : 'bg-white/[0.025]',
                  s.playerId === youId && !winner && 'ring-1 ring-fuchsia-400/25',
                )}
              >
                <span className={cn('w-5 text-center font-display font-bold', winner ? 'text-amber-300' : 'text-zinc-500')}>
                  {i + 1}
                </span>
                <div className="relative">
                  <PlayerAvatar name={s.name} seed={s.playerId} size="sm" />
                  {winner && (
                    <Crown className="absolute -right-2 -top-2.5 size-4 rotate-12 fill-amber-400 text-amber-400" />
                  )}
                </div>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">
                    {s.name}
                    {s.playerId === youId && <span className="text-zinc-500"> (you)</span>}
                  </span>
                  <span className="text-xs text-zinc-500">
                    {s.roundWins} round win{s.roundWins === 1 ? '' : 's'}
                  </span>
                </span>
                <span className="font-display text-xl font-extrabold">
                  <CountUp to={s.total} ms={1400} />
                </span>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

