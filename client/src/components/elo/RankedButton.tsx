import { Swords } from 'lucide-react';
import { rankedUnlocked } from '@dub/shared';
import { unlockAudio } from '@/audio/context';
import { joinQueue, useQueue } from '@/components/match';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useMe } from '@/state/me';
import { saveName } from '@/state/storage';

/**
 * "Ranked" next to "Join a random game" (V09): same queue with `mode: 'ranked'`, matched by
 * Elo. Rendered only once the user has played `RANKED_MIN_GAMES` public games.
 */
export function RankedButton({ name, className }: { name: string; className?: string }) {
  const user = useMe((s) => s.user);
  const queued = useQueue((s) => s.status !== 'idle');
  if (!rankedUnlocked(user)) return null;
  return (
    <Button
      variant="outline"
      size="lg"
      disabled={!name || queued}
      data-testid="ranked-game"
      title={name ? `Play strangers near your rating (${user!.elo})` : 'Enter your name first'}
      className={cn('shrink-0', className)}
      onClick={() => {
        unlockAudio();
        saveName(name);
        joinQueue(name, 'ranked');
      }}
    >
      <Swords /> Ranked
    </Button>
  );
}
