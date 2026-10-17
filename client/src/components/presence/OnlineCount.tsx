import { usePresenceCounts } from '@/net/presence';
import { cn } from '@/lib/utils';

/** " · N online" suffix for the Create room button (V07). Renders nothing until counts arrive. */
export function OnlineCount({ className }: { className?: string }) {
  const counts = usePresenceCounts();
  if (!counts) return null;
  return (
    <span
      data-testid="online-count"
      className={cn('font-sans text-sm font-semibold tabular-nums opacity-80', className)}
    >
      · {counts.online} online
    </span>
  );
}
