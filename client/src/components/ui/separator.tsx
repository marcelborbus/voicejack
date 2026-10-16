import { cn } from '@/lib/utils';

export function Separator({
  className,
  vertical = false,
}: {
  className?: string;
  vertical?: boolean;
}) {
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      className={cn(
        'shrink-0 bg-white/[0.08]',
        vertical ? 'h-full w-px' : 'h-px w-full',
        className,
      )}
    />
  );
}
