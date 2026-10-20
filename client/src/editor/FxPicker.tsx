import { FX_INFO, type FxId } from '@dub/shared';
import { useEffect, useRef } from 'react';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';
import { FX_CHOICES, randomFx, transport, useEditor } from './editorStore';

/**
 * #48 effect picker: a button next to Record that opens a grid of emoji tiles. Picking a tile
 * sets the effect for new takes, applies it to the selected take, and previews ~2 s of that
 * take (or the last one). Static on purpose (#49/#50): no blur, no looping animation; the
 * panel fades in once, and not at all with reduced motion.
 */
export function FxPicker({ onPick, disabled }: { onPick: (fx: FxId) => void; disabled?: boolean }) {
  const open = useEditor((s) => s.fxOpen);
  const sticky = useEditor((s) => s.fx);
  const sel = useEditor((s) => s.chunks.find((c) => c.meta.id === s.selectedId) ?? null);
  const hasTakes = useEditor((s) => s.chunks.some((c) => c.buffer !== null));
  const active: FxId = sel ? (sel.meta.fx ?? 'none') : sticky;
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on a pointer down outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        transport.setFxOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  useEffect(() => {
    if (disabled && open) transport.setFxOpen(false);
  }, [disabled, open]);

  const info = FX_INFO[active];
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="fx-button"
        data-fx={active}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Voice effect: ${info.name}`}
        title={`Voice effect: ${info.name} (E)`}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => transport.setFxOpen(!open)}
        className={cn(
          'inline-flex h-13 items-center gap-2 rounded-2xl border border-white/5 bg-zinc-800 px-3 font-display text-sm font-bold text-zinc-100',
          'shadow-lg shadow-black/30 transition-colors hover:bg-zinc-700/90 disabled:pointer-events-none disabled:opacity-45',
          active !== 'none' && 'border-fuchsia-400/40 bg-fuchsia-500/15',
        )}
      >
        <span className="text-xl leading-none" aria-hidden>
          {info.emoji}
        </span>
        <span className="hidden sm:inline">FX</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Voice effects"
          data-testid="fx-picker"
          className="absolute bottom-full right-0 z-40 mb-2 w-[min(calc(100vw-2rem),22rem)] rounded-2xl border-2 border-[#1a1027] bg-ink-900 p-3 shadow-[0_6px_0_rgb(0_0_0/0.5)] motion-safe:animate-fade-in"
        >
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <p className="text-xs font-semibold text-zinc-300">
              {sel ? (
                <>
                  Effect for <span className="text-zinc-50">take {sel.take}</span> and new takes
                </>
              ) : (
                'Effect for new takes'
              )}
            </p>
            <span className="flex items-center gap-1 text-[10px] text-zinc-500">
              <Kbd>E</Kbd> <Kbd>⇧</Kbd>+<Kbd>E</Kbd>
            </span>
          </div>
          <div className="grid grid-cols-6 gap-1.5">
            {FX_CHOICES.map((fx) => (
              <button
                key={fx}
                type="button"
                data-testid={`fx-${fx}`}
                aria-pressed={fx === active}
                title={FX_INFO[fx].name}
                aria-label={FX_INFO[fx].name}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(fx)}
                className={cn(
                  'flex aspect-square items-center justify-center rounded-xl border text-2xl leading-none transition-colors',
                  fx === active
                    ? 'border-fuchsia-300 bg-fuchsia-500/25'
                    : 'border-white/[0.06] bg-white/[0.04] hover:bg-white/[0.1]',
                )}
              >
                <span aria-hidden>{FX_INFO[fx].emoji}</span>
              </button>
            ))}
            <button
              type="button"
              data-testid="fx-random"
              title="Random effect"
              aria-label="Random effect"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(randomFx(active))}
              className="flex aspect-square items-center justify-center rounded-xl border border-white/[0.06] bg-white/[0.04] text-2xl leading-none transition-colors hover:bg-white/[0.1]"
            >
              <span aria-hidden>🎲</span>
            </button>
          </div>
          <p className="mt-2 truncate px-1 text-xs text-zinc-400" data-testid="fx-name">
            {info.emoji} {info.name}
            {hasTakes ? ' · tap a tile to hear it' : ''}
          </p>
        </div>
      )}
    </div>
  );
}
