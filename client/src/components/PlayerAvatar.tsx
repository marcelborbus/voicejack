import { useMemo } from 'react';
import { avatarSvg, mysteryAvatarSvg } from '@/lib/avatar';
import { cn } from '@/lib/utils';

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return [...parts[0]!].slice(0, 2).join('').toUpperCase();
  return ([...parts[0]!][0]! + [...parts[1]!][0]!).toUpperCase();
}

const SIZE = {
  xs: 'size-6 rounded-lg border-[1.5px]',
  sm: 'size-8 rounded-xl',
  md: 'size-12 rounded-2xl',
  lg: 'size-16 rounded-3xl',
  xl: 'size-24 rounded-[2rem] border-[2.5px]',
} as const;

/**
 * A player's doodle "mug" (see `lib/avatar.ts`). The face is generated from the *name*, so the
 * preview on Home matches what everyone else sees. `seed` is accepted for API compatibility
 * and ignored. `mystery` renders the anonymous "?" face.
 */
export function PlayerAvatar({
  name,
  size = 'md',
  className,
  dimmed = false,
  mystery = false,
}: {
  name: string;
  /** @deprecated ignored: the face follows the name. */
  seed?: string;
  size?: keyof typeof SIZE;
  className?: string;
  dimmed?: boolean;
  mystery?: boolean;
}) {
  const svg = useMemo(() => (mystery ? mysteryAvatarSvg() : avatarSvg(name)), [name, mystery]);
  return (
    <span
      aria-hidden
      className={cn(
        'mug inline-flex shrink-0 select-none overflow-hidden border-2 border-[#1a1027]',
        // `!`: buttons size every descendant svg as an icon (`[&_svg]:size-4`), which shrank
        // the face into the mug's top-left corner (#40).
        'shadow-[0_3px_0_rgb(0_0_0/0.45)] [&>svg]:block [&>svg]:size-full!',
        SIZE[size],
        dimmed && 'opacity-40 grayscale',
        className,
      )}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
