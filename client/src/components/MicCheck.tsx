import { AlertTriangle, CheckCircle2, Mic, MicOff, RotateCcw } from 'lucide-react';
import { useEffect } from 'react';
import { unlockAudio } from '@/audio/context';
import { LevelMeter } from '@/audio/LevelMeter';
import { acquireMic, prefetchMic, useMic } from '@/audio/mic';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

/** Mic permission + signal check. Reports `micStatus` to the server via the mic module. */
export function MicCheck({ className }: { className?: string }) {
  const { status, micOk, progress, error, deviceLabel, silent } = useMic();

  // If permission was granted before (reload), reopen the mic without asking again (the room
  // route usually did this already, #53).
  useEffect(() => prefetchMic(), []);

  const start = () => {
    void unlockAudio(); // inside the click gesture
    void acquireMic();
  };

  const failed = status === 'denied' || status === 'unavailable' || status === 'lost';
  const live = status === 'live';

  return (
    <div
      className={cn('flex flex-col gap-4', className)}
      data-testid="mic-check-panel"
      data-mic-ok={micOk}
      data-mic-silent={silent}
    >
      <div className="flex items-center gap-4">
        <span
          className={cn(
            'relative inline-flex size-14 shrink-0 items-center justify-center rounded-2xl ring-1 transition-colors duration-300',
            micOk && 'bg-emerald-400/15 ring-emerald-400/40',
            live && !micOk && 'animate-pulse-ring bg-fuchsia-500/15 ring-fuchsia-400/40',
            failed && 'bg-rose-500/15 ring-rose-500/40',
            !live && !failed && 'bg-white/[0.04] ring-white/10',
          )}
        >
          {micOk ? (
            <CheckCircle2 className="size-7 animate-pop text-emerald-300" />
          ) : failed ? (
            <MicOff className="size-7 text-rose-300" />
          ) : status === 'requesting' ? (
            <Spinner className="size-7" />
          ) : (
            <Mic className={cn('size-7', live ? 'text-fuchsia-300' : 'text-zinc-300')} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-lg font-bold leading-tight" data-testid="mic-status-text">
            {micOk
              ? 'Mic works!'
              : live
                ? silent
                  ? "Can't hear you"
                  : 'Say something…'
                : status === 'requesting'
                  ? 'Allow microphone access'
                  : failed
                    ? status === 'lost'
                      ? 'Microphone lost'
                      : 'No microphone'
                    : 'Check your microphone'}
          </p>
          <p className="truncate text-sm text-zinc-400">
            {micOk
              ? (deviceLabel ?? 'We can hear you.')
              : live
                ? silent
                  ? 'No sound from this mic. Is it muted, or is another input selected?'
                  : 'Talk normally for a moment so we can hear you.'
                : status === 'requesting'
                  ? 'Your browser is asking for permission.'
                  : failed
                    ? error
                    : 'Everyone needs a working mic to play.'}
          </p>
        </div>
      </div>

      {live && (
        <div className="flex flex-col gap-2">
          <LevelMeter />
          {!micOk && (
            <Progress value={progress * 100} className="h-1.5" aria-label="Detection progress" />
          )}
        </div>
      )}

      {failed && error && status !== 'lost' && (
        <p className="flex items-start gap-2 rounded-xl bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          Tip: click the lock or mic icon left of the address bar to change the permission.
        </p>
      )}

      {(status === 'idle' || failed) && (
        <Button onClick={start} data-testid="mic-check" size="lg">
          {failed ? <RotateCcw /> : <Mic />}
          {failed ? 'Try again' : 'Test microphone'}
        </Button>
      )}
    </div>
  );
}
