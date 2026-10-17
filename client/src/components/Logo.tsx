import { cn } from '@/lib/utils';

export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'relative inline-flex size-10 items-center justify-center rounded-2xl bg-brand shadow-lg shadow-fuchsia-500/30',
        className,
      )}
    >
      <svg viewBox="0 0 24 24" className="size-[58%] text-white" fill="none" aria-hidden>
        <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
        <path
          d="M5.5 11.5a6.5 6.5 0 0 0 13 0"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path d="M12 18v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className="font-display text-2xl font-extrabold tracking-tight">
        Voice<span className="text-brand">jack</span>
      </span>
    </span>
  );
}
