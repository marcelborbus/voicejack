import { Shuffle } from 'lucide-react';
import { unlockAudio } from '@/audio/context';
import { QueueOverlay, joinQueue, useMatchNavigation, useQueue } from '@/components/match';
import { Button } from '@/components/ui/button';
import { usePresenceCounts } from '@/net/presence';
import { cn } from '@/lib/utils';
import { getSavedName, saveName } from '@/state/storage';

/**
 * "Join a random game · N looking" (V07 counts, V08 queue). Opens the queue overlay; on
 * `matchFound` it navigates to the public room. `name` is the Home page's name field.
 */
export function RandomGameButton({ className, name }: { className?: string; name?: string }) {
  const counts = usePresenceCounts();
  const queued = useQueue((s) => s.status !== 'idle');
  useMatchNavigation();
  const playerName = (name ?? getSavedName()).trim();
  return (
    <>
      <Button
        variant="outline"
        size="lg"
        disabled={!playerName || queued}
        data-testid="random-game"
        title={playerName ? 'Play with strangers (3–6 players)' : 'Enter your name first'}
        className={cn('w-full', className)}
        onClick={() => {
          unlockAudio(); // inside the click gesture
          saveName(playerName);
          joinQueue(playerName);
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
      <QueueOverlay />
    </>
  );
}
