import { Mic, MicOff, Volume2, VolumeOff } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { VoiceRosterButton } from '@/components/voice/PeerVoiceControls';
import { useMe, usePhase } from '@/state/room';
import { VoiceMesh } from './VoiceMesh';
import { toggleSelfMute, useVoice } from './voiceStore';

/**
 * Runs the voice mesh while mounted (inside the room). Remote <audio> elements live in a
 * hidden container. The self-mute control is `VoiceDock`, rendered inline in the room header
 * (a fixed floating dock covered the vote and save panels on phones).
 */
export function VoiceProvider() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (typeof RTCPeerConnection === 'undefined' || !ref.current) return;
    const mesh = new VoiceMesh(ref.current);
    return () => mesh.dispose();
  }, []);
  return (
    <>
      <div ref={ref} hidden aria-hidden data-testid="voice-audio" />
    </>
  );
}

/** Inline voice pill: self-mute + status + players' voices (#43). Lives in the room header. */
export function VoiceDock() {
  const phase = usePhase();
  const hostMuted = !!useMe()?.mutedByHost;
  const allowed = useVoice((s) => s.allowed);
  const selfMuted = useVoice((s) => s.selfMuted);
  const speaking = useVoice((s) => s.selfSpeaking);
  const peerCount = useVoice((s) => Object.values(s.peers).filter((p) => p === 'connected').length);
  if (!phase || typeof RTCPeerConnection === 'undefined') return null;

  return (
    <div
      className="flex animate-fade-in items-center gap-2 rounded-2xl border border-white/10 bg-zinc-900/80 p-0.5 pr-3"
      data-testid="voice-dock"
      data-allowed={allowed}
    >
      {allowed && hostMuted ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex size-8 items-center justify-center rounded-lg bg-rose-500/20 text-rose-300"
              data-testid="voice-host-muted"
            >
              <MicOff className="size-4" />
            </span>
          </TooltipTrigger>
          <TooltipContent>The host muted you for everyone</TooltipContent>
        </Tooltip>
      ) : allowed ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-sm"
              variant={selfMuted ? 'destructive' : 'secondary'}
              aria-pressed={selfMuted}
              aria-label={selfMuted ? 'Unmute yourself' : 'Mute yourself'}
              data-testid="voice-self-mute"
              onClick={toggleSelfMute}
              className={cn(speaking && !selfMuted && 'ring-2 ring-emerald-400/70')}
            >
              {selfMuted ? <MicOff /> : <Mic />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{selfMuted ? 'Unmute' : 'Mute'} your voice chat</TooltipContent>
        </Tooltip>
      ) : (
        <span className="inline-flex size-8 items-center justify-center rounded-lg bg-zinc-800 text-zinc-400">
          <VolumeOff className="size-4" />
        </span>
      )}
      <span className="whitespace-nowrap text-xs font-semibold text-zinc-300">
        {allowed && hostMuted ? (
          <span className="text-rose-300">Host muted you</span>
        ) : allowed ? (
          <span className="flex items-center gap-1.5">
            <Volume2 className="size-3.5 text-emerald-300" />
            Voice on
            {peerCount > 0 && (
              <span className="hidden text-zinc-400 sm:inline">· {peerCount} connected</span>
            )}
          </span>
        ) : (
          <span className="text-zinc-400">
            Voice off<span className="hidden sm:inline"> while you dub</span>
          </span>
        )}
      </span>
      <VoiceRosterButton className="-mr-2" />
    </div>
  );
}
