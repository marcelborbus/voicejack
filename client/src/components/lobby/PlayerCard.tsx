import type { PlayerPublic } from '@dub/shared';
import { Check, Crown, Mic, MicOff, UserX, WifiOff } from 'lucide-react';
import { useState } from 'react';
import { PlayerAvatar } from '@/components/PlayerAvatar';
import { VoiceStatus } from '@/components/VoiceStatus';
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
        'group relative flex animate-pop items-center gap-3 rounded-3xl border p-3 pr-4 transition-colors duration-300',
        player.ready
          ? 'border-emerald-400/30 bg-emerald-400/[0.06]'
          : 'border-white/[0.07] bg-white/[0.025] hover:border-white/15',
        isSelf && !player.ready && 'border-fuchsia-400/30',
      )}
    >
      <div className="relative">
        <PlayerAvatar name={player.name} seed={player.id} dimmed={offline} />
        {player.isHost && (
          <span
            title="Host"
            className="absolute -left-1.5 -top-2 inline-flex size-6 rotate-[-14deg] items-center justify-center rounded-full bg-amber-400 shadow-md shadow-amber-500/40 ring-2 ring-zinc-900"
          >
            <Crown className="size-3.5 text-amber-950" strokeWidth={2.5} />
          </span>
        )}
        {player.ready && (
          <span className="absolute -bottom-1 -right-1 inline-flex size-5 animate-pop items-center justify-center rounded-full bg-emerald-400 ring-2 ring-zinc-900">
            <Check className="size-3 text-emerald-950" strokeWidth={3.5} />
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
            <span className="rounded-md bg-fuchsia-500/15 px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-fuchsia-200">
              you
            </span>
          )}
          <VoiceStatus playerId={player.id} isSelf={isSelf} />
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
        </div>
      </div>

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
