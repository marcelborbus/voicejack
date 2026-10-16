import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

export const buttonVariants = cva(
  [
    'relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap font-semibold',
    'transition-[transform,background-color,box-shadow,opacity,color] duration-150 ease-out',
    'active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fuchsia-400',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        default: [
          'bg-brand bg-[length:140%_140%] bg-[position:0%_50%] text-white shadow-lg shadow-fuchsia-500/25',
          'hover:bg-[position:100%_50%] hover:shadow-xl hover:shadow-fuchsia-500/35',
        ],
        secondary: 'bg-zinc-800 text-zinc-50 hover:bg-zinc-700/90 border border-white/5',
        outline:
          'border border-white/12 bg-white/[0.02] text-zinc-100 hover:bg-white/[0.06] hover:border-white/20',
        ghost: 'text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-50',
        destructive: 'bg-rose-500/90 text-white hover:bg-rose-500 shadow-lg shadow-rose-500/20',
        success:
          'bg-emerald-500 text-emerald-950 hover:bg-emerald-400 shadow-lg shadow-emerald-500/20',
        link: 'text-fuchsia-300 underline-offset-4 hover:underline px-0 h-auto',
      },
      size: {
        sm: 'h-9 rounded-xl px-3.5 text-sm [&_svg]:size-4',
        default: 'h-11 rounded-2xl px-5 text-[15px] [&_svg]:size-[18px]',
        lg: 'h-13 rounded-2xl px-7 text-base [&_svg]:size-5',
        xl: 'h-16 rounded-3xl px-9 text-lg font-display font-bold tracking-tight [&_svg]:size-6',
        icon: 'size-10 rounded-xl [&_svg]:size-[18px]',
        'icon-sm': 'size-8 rounded-lg [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : (type ?? 'button')}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';
