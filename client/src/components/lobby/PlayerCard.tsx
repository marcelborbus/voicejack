import type { PlayerPublic } from '@dub/shared';
import { Check, Crown, Mic, MicOff, UserX, WifiOff } from 'lucide-react';
import { useState } from 'react';
import { PlayerAvatar } from '@/components/PlayerAvatar';
import { BotBadge } from '@/components/lobby/BotControls';
import { VoiceStatus } from '@/components/VoiceStatus';
import {
  HostMutedBadge,
  PeerMuteButton,
  PeerVoiceMenu,
} from '@/components/voice/PeerVoiceControls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { send } from '@/state/session';

export function PlayerCard({
  player,
  isSelf,
  canKick,
  index = 0,
}: {
  player: PlayerPublic;
  isSelf: boolean;
  canKick: boolean;
  index?: number;
}) {
  const [confirm, setConfirm] = useState(false);
  const offline = !player.connected;
  return (
    <li
      data-testid="player-card"
      data-player-id={player.id}
      data-ready={player.ready}
      data-mic-ok={player.micOk}
      style={{ animationDelay: `${index * 40}ms` }}
      className={cn(
        'group relative flex animate-pop items-center gap-3 rounded-3xl border-[1.5px] p-3 pr-4 transition-colors duration-300',
        'shadow-[0_4px_0_rgb(0_0_0/0.4)]',
        player.ready
          ? 'border-emerald-400/35 bg-emerald-400/[0.07]'
          : 'border-white/10 bg-ink-850 hover:border-white/20',
        isSelf && !player.ready && 'border-fuchsia-400/40',
      )}
    >
      <div className="relative">
        <PlayerAvatar name={player.name} seed={player.id} dimmed={offline} />
        {player.isHost && (
          <span
            title="Host"
            className="absolute -left-2 -top-2.5 z-10 inline-flex size-6 rotate-[-14deg] items-center justify-center rounded-full border-2 border-[#1a1027] bg-sun"
          >
            <Crown className="size-3.5 text-amber-950" strokeWidth={2.5} />
          </span>
        )}
        {player.ready && (
          <span className="absolute -bottom-1.5 -right-1.5 inline-flex size-6 animate-stamp items-center justify-center rounded-full border-2 border-[#1a1027] bg-lime">
            <Check className="size-3.5 text-[#1a1027]" strokeWidth={3.5} />
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn('truncate font-semibold', offline && 'text-zinc-500')}
            data-testid="player-name"
          >
            {player.name}
          </span>
          {isSelf && (
            <span className="-rotate-6 rounded-md bg-sun px-1.5 py-px text-[10px] font-extrabold uppercase tracking-wider text-[#1a1027]">
              you
            </span>
          )}
          {player.isBot ? <BotBadge /> : <VoiceStatus playerId={player.id} isSelf={isSelf} />}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {offline ? (
            <Badge variant="danger">
              <WifiOff /> offline
            </Badge>
          ) : (
            <>
              <Badge variant={player.micOk ? 'success' : 'secondary'} data-testid="mic-badge">
                {player.micOk ? <Mic /> : <MicOff />}
                {player.micOk ? 'mic ok' : 'no mic yet'}
              </Badge>
              <Badge variant={player.ready ? 'success' : 'outline'} data-testid="ready-badge">
                {player.ready ? 'ready' : 'not ready'}
              </Badge>
            </>
          )}
          <HostMutedBadge player={player} />
        </div>
      </div>

      {!isSelf && !player.isBot && (
        <div className="flex shrink-0 flex-col items-center gap-1">
          <PeerMuteButton player={player} />
          <PeerVoiceMenu player={player} />
        </div>
      )}

      {canKick && !isSelf && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${player.name}`}
                data-testid="kick-player"
                className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => setConfirm(true)}
              >
                <UserX />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Remove from room</TooltipContent>
          </Tooltip>
          <Dialog open={confirm} onOpenChange={setConfirm}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>Remove {player.name}?</DialogTitle>
                <DialogDescription>
                  They can rejoin with the invite link while you're in the lobby.
                </DialogDescription>
              </DialogHeader>
              <div className="flex justify-end gap-2">
                <DialogClose asChild>
                  <Button variant="ghost">Cancel</Button>
                </DialogClose>
                <Button
                  variant="destructive"
                  data-testid="kick-confirm"
                  onClick={() => {
                    send({ t: 'kick', playerId: player.id });
                    setConfirm(false);
                  }}
                >
                  Remove
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}
    </li>
  );
}
