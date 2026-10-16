import * as ToastPrimitive from '@radix-ui/react-toast';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useToasts, type ToastVariant } from '@/lib/toast';
import { cn } from '@/lib/utils';

const ICONS: Record<ToastVariant, typeof Info> = {
  default: Info,
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
};
const ICON_COLOR: Record<ToastVariant, string> = {
  default: 'text-fuchsia-300',
  success: 'text-emerald-300',
  error: 'text-rose-400',
  warning: 'text-amber-300',
};

/** Mount once near the root. Use `toast()` from `@/lib/toast` to show one. */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <ToastPrimitive.Provider swipeDirection="right">
      {toasts.map((t) => {
        const Icon = ICONS[t.variant];
        return (
          <ToastPrimitive.Root
            key={t.id}
            duration={t.durationMs}
            onOpenChange={(open) => !open && dismiss(t.id)}
            data-testid="toast"
            data-variant={t.variant}
            className={cn(
              'group pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-2xl border p-4 pr-10',
              'border-white/10 bg-zinc-900/95 shadow-2xl shadow-black/60 backdrop-blur-xl',
              'data-[state=open]:animate-toast-in data-[state=closed]:animate-toast-out',
              'data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=end]:animate-toast-out',
              t.variant === 'error' && 'border-rose-500/30',
            )}
          >
            <Icon className={cn('mt-0.5 size-5 shrink-0', ICON_COLOR[t.variant])} />
            <div className="min-w-0 flex-1">
              <ToastPrimitive.Title className="text-sm font-semibold text-zinc-50">
                {t.title}
              </ToastPrimitive.Title>
              {t.description && (
                <ToastPrimitive.Description className="mt-0.5 text-sm text-zinc-400">
                  {t.description}
                </ToastPrimitive.Description>
              )}
            </div>
            <ToastPrimitive.Close
              aria-label="Dismiss"
              className="absolute right-2.5 top-2.5 rounded-lg p-1 text-zinc-500 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="size-4" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        );
      })}
      <ToastPrimitive.Viewport className="fixed bottom-0 right-0 z-[100] flex w-full max-w-sm flex-col gap-2 p-4 outline-none sm:bottom-4 sm:right-4" />
    </ToastPrimitive.Provider>
  );
}
