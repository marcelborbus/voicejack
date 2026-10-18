import { Shuffle } from 'lucide-react';
import { unlockAudio } from '@/audio/context';
import { RankedButton } from '@/components/elo';
import { QueueOverlay, joinQueue, useMatchNavigation, useQueue } from '@/components/match';
import { Button } from '@/components/ui/button';
import { usePresenceCounts } from '@/net/presence';
import { cn } from '@/lib/utils';
import { getSavedName, saveName } from '@/state/storage';

/**
 * "Join a random game · N looking" (V07 counts, V08 queue). Opens the queue overlay; on
 * `matchFound` it navigates to the public room. `name` is the Home page's name field.
 * V09: "Ranked" sits next to it once unlocked (3 public games).
 */
export function RandomGameButton({ className, name }: { className?: string; name?: string }) {
  const counts = usePresenceCounts();
  const queued = useQueue((s) => s.status !== 'idle');
  useMatchNavigation();
  const playerName = (name ?? getSavedName()).trim();
  return (
    <div className={cn('flex w-full gap-2', className)}>
      <Button
        variant="outline"
        size="lg"
        disabled={!playerName || queued}
        data-testid="random-game"
        title={playerName ? 'Play with strangers (3–6 players)' : 'Enter your name first'}
        className="min-w-0 flex-1"
        onClick={() => {
          unlockAudio(); // inside the click gesture
          saveName(playerName);
          joinQueue(playerName, 'casual');
        }}
      >
        <Shuffle />
        Join a random game
        {counts && (
          <span data-testid="looking-count" className="tabular-nums text-zinc-400">
            · {counts.lookingForGame} looking
          </span>
        )}
      </Button>
      <RankedButton name={playerName} />
      <QueueOverlay />
    </div>
  );
}
