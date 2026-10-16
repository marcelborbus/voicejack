import * as React from 'react';
import { cn } from '@/lib/utils';

export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-white/10 border-b-2',
        'bg-zinc-800/80 px-1.5 font-mono text-[11px] font-medium text-zinc-300',
        className,
      )}
      {...props}
    />
  );
}
