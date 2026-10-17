import { Crown, Medal, MicOff, RotateCcw, Share2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Sparkle } from '@/components/doodles';
import { AddFriendButton } from '@/components/friends';
import { PlayerAvatar } from '@/components/PlayerAvatar';
import { BestDubReplay, useDubChunks } from '@/components/results/BestDubReplay';
import { Confetti, CountUp } from '@/components/results/motion';
import { SaveVideo } from '@/components/results/SaveVideo';
import { SupportPrompt } from '@/components/support';
import { PublicFinalActions } from '@/components/match';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { play } from '@/lib/sfx';
import { shareResults } from '@/lib/shareCard';
import { toast } from '@/lib/toast';
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
  const hasFinal = !!final;
  useEffect(() => {
    if (hasFinal) play('tada');
  }, [hasFinal]);
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
        <div className="dub-trophy relative">
          {winnerNames.length > 0 ? (
            <PlayerAvatar name={winnerNames[0]!} size="xl" className="size-28 rounded-[2.25rem]" />
          ) : (
            <PlayerAvatar name="?" mystery size="xl" />
          )}
          {winnerNames.length > 0 && (
            <Crown
              aria-hidden
              strokeWidth={2.5}
              className="absolute -right-5 -top-7 size-12 rotate-[18deg] fill-sun text-[#1a1027]"
            />
          )}
          <Sparkle className="absolute -left-10 top-2 size-7 animate-sway text-jack" />
        </div>
        <p className="tape">{final.winners.length > 1 ? 'Shared victory' : 'And the winner is'}</p>
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
              {snap.kind === 'public' ? (
                <PublicFinalActions />
              ) : isHost ? (
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
              <ShareResultsButton final={final} rounds={snap.totalRounds} />
              <p className="text-center text-xs text-zinc-500">
                Scores reset in the lobby. Clips you've played won't come up again in this room.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
      <SupportPrompt />
    </div>
  );
}

function ShareResultsButton({ final, rounds }: { final: FinalResult; rounds: number }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      size="lg"
      data-testid="share-results"
      disabled={busy || final.standings.length === 0}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await shareResults({
            rounds,
            standings: final.standings.map((s) => ({
              name: s.name,
              total: s.total,
              winner: final.winners.includes(s.playerId),
            })),
          });
          if (r === 'downloaded')
            toast('Results card saved', {
              variant: 'success',
              description: 'Post it in the group chat.',
              durationMs: 2500,
            });
        } catch (e) {
          console.error('[share] results card failed', e);
          toast('Could not make the results card', { variant: 'warning' });
        } finally {
          setBusy(false);
        }
      }}
    >
      <Share2 /> {busy ? 'Drawing…' : 'Share results'}
    </Button>
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
                    : 'bg-ink-850',
                  s.playerId === youId && !winner && 'ring-1 ring-fuchsia-400/25',
                )}
              >
                <span
                  className={cn(
                    'w-5 text-center font-display font-bold',
                    winner ? 'text-amber-300' : 'text-zinc-500',
                  )}
                >
                  {i + 1}
                </span>
                <div className="relative">
                  <PlayerAvatar name={s.name} seed={s.playerId} size="sm" />
                  {winner && (
                    <Crown className="absolute -right-2 -top-2.5 size-4 rotate-12 fill-sun text-[#1a1027]" />
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
                {s.playerId !== youId && <AddFriendButton playerId={s.playerId} />}
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
