import * as SliderPrimitive from '@radix-ui/react-slider';
import * as React from 'react';
import { cn } from '@/lib/utils';

export const Slider = React.forwardRef<
  React.ComponentRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & { thumbClassName?: string }
>(({ className, thumbClassName, ...props }, ref) => {
  const count = (props.value ?? props.defaultValue ?? [0]).length;
  return (
    <SliderPrimitive.Root
      ref={ref}
      className={cn(
        'relative flex w-full touch-none select-none items-center py-2 data-[disabled]:opacity-45',
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-2.5 w-full grow overflow-hidden rounded-full bg-zinc-800">
        <SliderPrimitive.Range className="absolute h-full bg-brand" />
      </SliderPrimitive.Track>
      {Array.from({ length: count }, (_, i) => (
        <SliderPrimitive.Thumb
          key={i}
          className={cn(
            'block size-6 rounded-full border-4 border-white bg-fuchsia-500 shadow-lg shadow-fuchsia-500/40',
            'transition-transform duration-150 hover:scale-110 focus-visible:scale-110',
            'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-fuchsia-500/30',
            thumbClassName,
          )}
        />
      ))}
    </SliderPrimitive.Root>
  );
});
Slider.displayName = 'Slider';
