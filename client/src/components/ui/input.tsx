import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type = 'text', ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      'flex h-12 w-full rounded-2xl border-[1.5px] border-white/12 bg-ink-950/70 px-4 text-base text-zinc-50',
      'placeholder:text-zinc-500 transition-[border-color,box-shadow] duration-150',
      'hover:border-white/20 focus-visible:border-fuchsia-400/70 focus-visible:outline-none',
      'focus-visible:ring-4 focus-visible:ring-fuchsia-500/20',
      'disabled:cursor-not-allowed disabled:opacity-50',
      'aria-[invalid=true]:border-rose-500/70 aria-[invalid=true]:ring-rose-500/20',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';
