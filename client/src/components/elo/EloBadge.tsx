import { Trophy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMe } from '@/state/me';

/**
 * The user's Elo for the account menu (V09). Hidden until the first public game, when the
 * rating starts to mean something.
 */
export function EloBadge({ className }: { className?: string }) {
  const user = useMe((s) => s.user);
  if (!user || user.publicGamesPlayed === 0) return null;
  return (
    <span
      data-testid="elo-badge"
      title={`Rating ${user.elo} · ${user.publicGamesPlayed} public game${user.publicGamesPlayed === 1 ? '' : 's'}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-400/10 px-2 py-0.5 text-xs font-bold tabular-nums text-amber-200',
        className,
      )}
    >
      <Trophy aria-hidden className="size-3.5" />
      <span className="sr-only">Rating </span>
      {user.elo}
    </span>
  );
}
