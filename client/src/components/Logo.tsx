import { cn } from '@/lib/utils';

/** Brand tile: a mic whose cable curls into a 3.5 mm jack plug. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'relative inline-flex size-10 -rotate-6 items-center justify-center rounded-2xl bg-brand',
        'border-2 border-[#1a1027] shadow-[0_3px_0_rgb(0_0_0/0.5)] transition-transform',
        'group-hover:animate-wiggle',
        className,
      )}
    >
      <svg viewBox="0 0 24 24" className="size-[64%] text-white" fill="none" aria-hidden>
        <rect x="8" y="2" width="7" height="11.5" rx="3.5" fill="currentColor" />
        <path
          d="M4.8 10.6a6.7 6.7 0 0 0 13.4 0"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="M11.5 17.4v1.1c0 2.6 3.3 3.2 5.2 1.7"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M16.6 20.3l2.3-1.7"
          stroke="currentColor"
          strokeWidth="2.8"
          strokeLinecap="round"
        />
        <path
          d="M19.9 17.9l1.5-1.1"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('group inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className="font-display text-2xl font-extrabold tracking-tight">
        Voice<span className="text-brand">jack</span>
      </span>
    </span>
  );
}
