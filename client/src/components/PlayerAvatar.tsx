import { cn } from '@/lib/utils';

// Hand-picked gradient pairs that read well on zinc-950.
const PALETTE = [
  ['#d946ef', '#f97316'],
  ['#8b5cf6', '#ec4899'],
  ['#06b6d4', '#8b5cf6'],
  ['#f43f5e', '#f59e0b'],
  ['#10b981', '#06b6d4'],
  ['#f59e0b', '#ef4444'],
  ['#6366f1', '#22d3ee'],
  ['#ec4899', '#a855f7'],
] as const;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return [...parts[0]!].slice(0, 2).join('').toUpperCase();
  return ([...parts[0]!][0]! + [...parts[1]!][0]!).toUpperCase();
}

export function PlayerAvatar({
  name,
  seed,
  size = 'md',
  className,
  dimmed = false,
}: {
  name: string;
  /** Stable seed (player id) so colours don't change on rename. */
  seed?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  dimmed?: boolean;
}) {
  const [a, b] = PALETTE[hash(seed ?? name) % PALETTE.length]!;
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-2xl font-display font-extrabold text-white',
        'shadow-inner shadow-white/20 ring-1 ring-white/15',
        size === 'sm' && 'size-8 rounded-xl text-xs',
        size === 'md' && 'size-12 text-base',
        size === 'lg' && 'size-16 rounded-3xl text-xl',
        size === 'xl' && 'size-24 rounded-[2rem] text-3xl',
        dimmed && 'opacity-40 grayscale',
        className,
      )}
      style={{ backgroundImage: `linear-gradient(135deg, ${a}, ${b})` }}
    >
      {initials(name)}
    </span>
  );
}
