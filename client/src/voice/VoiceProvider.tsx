import { Mic, MicOff, Volume2, VolumeOff } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { usePhase } from '@/state/room';
import { VoiceMesh } from './VoiceMesh';
import { toggleSelfMute, useVoice } from './voiceStore';

/**
 * Runs the voice mesh while mounted (inside the room) and shows a small floating voice dock
 * with the self-mute button. Remote <audio> elements live in a hidden container.
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
      <VoiceDock />
    </>
  );
}

function VoiceDock() {
  const phase = usePhase();
  const allowed = useVoice((s) => s.allowed);
  const selfMuted = useVoice((s) => s.selfMuted);
  const speaking = useVoice((s) => s.selfSpeaking);
  const peerCount = useVoice((s) => Object.values(s.peers).filter((p) => p === 'connected').length);
  if (!phase || typeof RTCPeerConnection === 'undefined') return null;

  return (
    <div
      className="fixed bottom-4 left-4 z-40 flex animate-fade-up items-center gap-2 rounded-2xl border border-white/10 bg-zinc-900/90 p-1.5 pr-3 shadow-2xl shadow-black/50 backdrop-blur-xl"
      data-testid="voice-dock"
      data-allowed={allowed}
    >
      {allowed ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
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
        <span className="inline-flex size-10 items-center justify-center rounded-xl bg-zinc-800 text-zinc-500">
          <VolumeOff className="size-[18px]" />
        </span>
      )}
      <span className="text-xs font-semibold text-zinc-300">
        {allowed ? (
          <span className="flex items-center gap-1.5">
            <Volume2 className="size-3.5 text-emerald-300" />
            Voice on{peerCount > 0 && <span className="text-zinc-500">· {peerCount} connected</span>}
          </span>
        ) : (
          <span className="text-zinc-400">Voice off while you dub</span>
        )}
      </span>
    </div>
  );
}
