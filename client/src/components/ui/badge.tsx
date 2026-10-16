import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

export const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-semibold [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-brand text-white',
        secondary: 'border-white/5 bg-zinc-800 text-zinc-200',
        outline: 'border-white/15 text-zinc-300',
        success: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
        warning: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
        danger: 'border-rose-500/25 bg-rose-500/10 text-rose-300',
        accent: 'border-fuchsia-400/25 bg-fuchsia-400/10 text-fuchsia-200',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
