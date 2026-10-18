import type { PlayerPublic } from '@dub/shared';
import { MicOff, SlidersHorizontal, Users, Volume2, VolumeX } from 'lucide-react';
import { useState } from 'react';
import { PlayerAvatar } from '@/components/PlayerAvatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useRoom } from '@/state/room';
import { send } from '@/state/session';
import { peerVolume } from '@/voice/voicePolicy';
import { setPeerVolume, togglePeerMute, useVoice } from '@/voice/voiceStore';

/**
 * Per-player voice controls (#43): local mute + volume (only what *you* hear) and, for the
 * host of a private room, "mute for everyone" (C2S `hostMute`, `PlayerPublic.mutedByHost`).
 */

/** The host of a private room may mute this (other, human) player for everyone. */
function useCanHostMute(player: PlayerPublic): boolean {
  return useRoom((s) => {
    const snap = s.snapshot;
    return (
      !!snap &&
      snap.kind === 'private' &&
      snap.hostId === snap.you.playerId &&
      player.id !== snap.you.playerId &&
      !player.isBot
    );
  });
}

export function hostMute(player: PlayerPublic, muted: boolean): void {
  send({ t: 'hostMute', playerId: player.id, muted });
}

/** Always-visible local mute toggle for a player card. */
export function PeerMuteButton({
  player,
  className,
}: {
  player: PlayerPublic;
  className?: string;
}) {
  const active = useVoice((s) => s.active);
  const muted = useVoice((s) => !!s.peerMuted[player.id]);
  if (!active) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={muted ? 'destructive' : 'outline'}
          size="icon-sm"
          aria-pressed={muted}
          aria-label={muted ? `Unmute ${player.name} for you` : `Mute ${player.name} for you`}
          data-testid="voice-peer-mute"
          onClick={() => togglePeerMute(player.id)}
          className={className}
        >
          {muted ? <VolumeX /> : <Volume2 />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{muted ? 'Unmute' : 'Mute'} for you</TooltipContent>
    </Tooltip>
  );
}

/** Small "muted by host" marker (cards, roster). */
export function HostMutedBadge({ player }: { player: PlayerPublic }) {
  if (!player.mutedByHost) return null;
  return (
    <Badge variant="danger" className="whitespace-normal" data-testid="host-muted-badge">
      <MicOff /> muted by host
    </Badge>
  );
}

/** One player's row: local mute, volume, host mute. */
export function PeerVoiceRow({ player }: { player: PlayerPublic }) {
  const muted = useVoice((s) => !!s.peerMuted[player.id]);
  const volume = useVoice((s) => peerVolume(s.peerVolume[player.id]));
  const canHostMute = useCanHostMute(player);
  return (
    <li
      className="flex flex-col gap-2 rounded-2xl border border-white/10 bg-ink-850 p-3"
      data-testid="voice-peer-row"
      data-player-id={player.id}
    >
      <div className="flex items-center gap-3">
        <PlayerAvatar name={player.name} size="sm" dimmed={!player.connected} />
        <span className="min-w-0 flex-1 truncate font-semibold">{player.name}</span>
        <HostMutedBadge player={player} />
        <PeerMuteButton player={player} />
      </div>
      <label className="flex items-center gap-3 text-xs text-zinc-400">
        <span className="w-14 shrink-0">Volume</span>
        <Slider
          value={[Math.round(volume * 100)]}
          min={0}
          max={100}
          step={5}
          disabled={muted}
          onValueChange={([v]) => setPeerVolume(player.id, (v ?? 100) / 100)}
          aria-label={`${player.name}'s volume`}
          data-testid="voice-peer-volume"
          thumbClassName="size-5 border-[3px]"
        />
        <span className="w-9 shrink-0 text-right font-mono tabular-nums">
          {Math.round(volume * 100)}%
        </span>
      </label>
      {canHostMute && (
        <Button
          variant={player.mutedByHost ? 'secondary' : 'outline'}
          size="sm"
          className="self-start"
          data-testid="host-mute"
          aria-pressed={!!player.mutedByHost}
          onClick={() => hostMute(player, !player.mutedByHost)}
        >
          {player.mutedByHost ? <Volume2 /> : <MicOff />}
          {player.mutedByHost ? 'Unmute for everyone' : 'Mute for everyone'}
        </Button>
      )}
    </li>
  );
}

/** Card button that opens one player's voice settings (volume, host mute). */
export function PeerVoiceMenu({ player }: { player: PlayerPublic }) {
  const active = useVoice((s) => s.active);
  const [open, setOpen] = useState(false);
  if (!active) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Voice settings for ${player.name}`}
              data-testid="voice-peer-menu"
            >
              <SlidersHorizontal />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>Volume and mute</TooltipContent>
      </Tooltip>
      <DialogContent className="max-w-sm" data-testid="voice-peer-dialog">
        <DialogHeader>
          <DialogTitle>{player.name}&apos;s voice</DialogTitle>
          <DialogDescription>Mute and volume only change what you hear.</DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2">
          <PeerVoiceRow player={player} />
        </ul>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Voice roster for every phase with voice (from the header's voice pill): each other human
 * player's mute / volume / host mute.
 */
export function VoiceRosterButton({ className }: { className?: string }) {
  const players = useRoom((s) => s.snapshot?.players);
  const selfId = useRoom((s) => s.snapshot?.you.playerId);
  const others = (players ?? []).filter((p) => p.id !== selfId && !p.isBot);
  const mutedCount = useVoice((s) => others.filter((p) => s.peerMuted[p.id]).length);
  if (others.length === 0) return null;
  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Players' voices"
              data-testid="voice-roster"
              className={cn('relative', className)}
            >
              <Users />
              {mutedCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 inline-flex size-4 items-center justify-center rounded-full bg-rose-500 text-[10px] font-bold text-white">
                  {mutedCount}
                </span>
              )}
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>Mute or turn down players</TooltipContent>
      </Tooltip>
      <DialogContent className="max-w-md" data-testid="voice-roster-dialog">
        <DialogHeader>
          <DialogTitle>Voices</DialogTitle>
          <DialogDescription>Mute and volume only change what you hear.</DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-[60dvh] flex-col gap-2 overflow-y-auto">
          {others.map((p) => (
            <PeerVoiceRow key={p.id} player={p} />
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
