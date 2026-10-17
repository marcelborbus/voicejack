import { Shuffle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePresenceCounts } from '@/net/presence';
import { cn } from '@/lib/utils';

/**
 * "Join a random game · N looking" (V07). Disabled with "coming soon" until public
 * matchmaking (V08) lands; V08 replaces `disabled` with the queue join.
 */
export function RandomGameButton({ className }: { className?: string }) {
  const counts = usePresenceCounts();
  return (
    <Button
      variant="outline"
      size="lg"
      disabled
      data-testid="random-game"
      title="Public matchmaking is coming soon"
      className={cn('w-full', className)}
    >
      <Shuffle />
      Join a random game
      {counts && (
        <span data-testid="looking-count" className="tabular-nums text-zinc-400">
          · {counts.lookingForGame} looking
        </span>
      )}
      <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-300">
        coming soon
      </span>
    </Button>
  );
}
