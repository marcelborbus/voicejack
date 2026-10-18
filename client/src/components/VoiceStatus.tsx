import type { PlayerId } from '@dub/shared';
import { Volume2, VolumeX } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { togglePeerMute, useVoice } from '@/voice/voiceStore';

/** Voice connection dot, speaking indicator and local mute for one player card. */
export function VoiceStatus({ playerId, isSelf }: { playerId: PlayerId; isSelf: boolean }) {
  const active = useVoice((s) => s.active);
  const state = useVoice((s) => s.peers[playerId]);
  const speaking = useVoice((s) => (isSelf ? s.selfSpeaking : !!s.speaking[playerId]));
  const muted = useVoice((s) => (isSelf ? s.selfMuted : !!s.peerMuted[playerId]));
  if (!active) return null;

  const bars = (
    <span
      className={cn('inline-flex h-3.5 items-end gap-[2px]', !speaking && 'opacity-30')}
      aria-label={speaking ? 'speaking' : undefined}
      data-testid="voice-speaking"
      data-speaking={speaking}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn(
            'w-[3px] rounded-full bg-emerald-400',
            speaking ? 'animate-[voice-bar_0.7s_ease-in-out_infinite]' : 'h-1',
          )}
          style={speaking ? { animationDelay: `${i * 120}ms`, height: '100%' } : undefined}
        />
      ))}
      <style>
        {'@keyframes voice-bar{0%,100%{transform:scaleY(.35)}50%{transform:scaleY(1)}}'}
      </style>
    </span>
  );

  if (isSelf)
    return muted ? <VolumeX className="size-3.5 text-rose-300" aria-label="you are muted" /> : bars;

  const label =
    state === 'connected'
      ? 'Voice connected'
      : state === 'failed'
        ? 'No direct route (voice unavailable)'
        : 'Connecting voice…';
  return (
    <span
      className="inline-flex items-center gap-1.5"
      data-testid="voice-status"
      data-state={state ?? 'none'}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'inline-block size-2 rounded-full',
              state === 'connected' && 'bg-emerald-400',
              state === 'failed' && 'bg-rose-500',
              (!state || state === 'connecting') && 'animate-pulse bg-amber-400',
            )}
          />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      {state === 'connected' && bars}
      {state === 'connected' && (
        <button
          type="button"
          onClick={() => togglePeerMute(playerId)}
          aria-pressed={muted}
          aria-label={muted ? 'Unmute this player' : 'Mute this player'}
          data-testid="voice-peer-mute"
          className="rounded-md p-0.5 text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
        >
          {muted ? (
            <VolumeX className="size-3.5 text-rose-300" />
          ) : (
            <Volume2 className="size-3.5" />
          )}
        </button>
      )}
      {state === 'failed' && (
        <span className="text-[10px] font-semibold text-rose-300">no route</span>
      )}
    </span>
  );
}
