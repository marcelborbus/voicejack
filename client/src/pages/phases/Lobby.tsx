import { MAX_PLAYERS } from '@dub/shared';
import { Film, UserPlus } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { InviteCard } from '@/components/InviteButton';
import { BotControls } from '@/components/lobby/BotControls';
import { PlayerCard } from '@/components/lobby/PlayerCard';
import { ReadyPanel } from '@/components/lobby/ReadyPanel';
import { SettingsPanel } from '@/components/lobby/SettingsPanel';
import { StartPanel } from '@/components/lobby/StartPanel';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { play } from '@/lib/sfx';
import { useIsHost, useMe, useRoom, useSnapshot } from '@/state/room';

/** pop when someone joins, ding when someone gets ready (never on first render). */
function useLobbySounds(joined: number, ready: number) {
  const prev = useRef<{ joined: number; ready: number } | null>(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = { joined, ready };
    if (!p) return;
    if (ready > p.ready) play('ding');
    else if (joined > p.joined) play('pop');
  }, [joined, ready]);
}

export function Lobby() {
  const snap = useSnapshot();
  const me = useMe();
  const isHost = useIsHost();
  const maxPlayers = useRoom((s) => s.limits.maxPlayers) || MAX_PLAYERS;
  useLobbySounds(snap?.players.length ?? 0, snap?.players.filter((p) => p.ready).length ?? 0);
  if (!snap || !me) return null;
  const { players, you } = snap;
  const host = players.find((p) => p.id === snap.hostId);
  const openSlots = Math.max(0, maxPlayers - players.length);

  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]"
      data-testid="lobby"
    >
      <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-6">
        <Card className="order-2 lg:order-none">
          <CardHeader className="gap-4">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <span className="tape text-sm">The cast</span>
                </CardTitle>
                <p className="mt-2 text-sm text-zinc-400">
                  <span className="tabular-nums">
                    {players.length}/{maxPlayers}
                  </span>{' '}
                  players · everyone can hear each other here
                </p>
              </div>
            </div>
            <InviteCard code={snap.code} hostName={host?.name} />
          </CardHeader>
          <CardContent>
            <ul className="grid gap-3 sm:grid-cols-2" data-testid="player-list">
              {players.map((p, i) => (
                <PlayerCard
                  key={p.id}
                  player={p}
                  isSelf={p.id === you.playerId}
                  canKick={isHost}
                  index={i}
                />
              ))}
              {openSlots > 0 && (
                <li className="relative flex items-center gap-3 rounded-3xl border-2 border-dashed border-white/12 p-3 text-zinc-400">
                  <span className="inline-flex size-12 -rotate-3 items-center justify-center rounded-2xl border-2 border-dashed border-white/20 bg-ink-850">
                    <UserPlus className="size-5" />
                  </span>
                  <span className="text-sm">
                    {players.length < 2
                      ? 'Seat for a friend: send them the invite'
                      : `${openSlots} seat${openSlots === 1 ? '' : 's'} left`}
                  </span>
                </li>
              )}
            </ul>
          </CardContent>
        </Card>

        <div className="order-3 lg:order-none">
          <StartPanel
            isHost={isHost}
            canStart={you.canStart}
            blockers={you.startBlockers}
            players={players}
            hostName={host?.name ?? 'the host'}
          />
        </div>
      </div>

      <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-6">
        <div className="order-1 lg:order-none">
          <ReadyPanel me={me} />
        </div>
        <div className="order-4 lg:order-none">
          <SettingsPanel
            settings={snap.settings}
            availableTags={snap.availableTags}
            clipCount={snap.clipCount}
            isHost={isHost}
          />
        </div>
        {you.canManageBots && (
          <div className="order-4 lg:order-none">
            <BotControls players={players} maxPlayers={maxPlayers} />
          </div>
        )}
        <p className="order-5 flex items-start gap-2 px-2 lg:order-none text-xs text-zinc-500">
          <Film className="mt-0.5 size-3.5 shrink-0" />
          All clips are Creative Commons or public domain. Each clip's author and license are shown
          while you dub it.
        </p>
      </div>
    </div>
  );
}
