import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { dbToMeter, MIC_OK_THRESHOLD_DB } from './levels';
import { getMicLevelDb } from './mic';

/**
 * Segmented input level meter. Polls the mic level per animation frame and writes styles
 * directly (no React re-render per frame). A tick marks the micOk threshold (-50 dBFS).
 */
export function LevelMeter({
  className,
  getLevelDb = getMicLevelDb,
  active = true,
}: {
  className?: string;
  getLevelDb?: () => number;
  active?: boolean;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const peakRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let shown = 0;
    let peak = 0;
    let peakAt = 0;
    const loop = (t: number) => {
      const v = dbToMeter(getLevelDb());
      // fast attack, slower release
      shown = v > shown ? v : shown + (v - shown) * 0.18;
      if (shown >= peak || t - peakAt > 900) {
        peak = shown;
        peakAt = t;
      }
      if (barRef.current) barRef.current.style.clipPath = `inset(0 ${(1 - shown) * 100}% 0 0)`;
      if (peakRef.current) peakRef.current.style.left = `calc(${peak * 100}% - 2px)`;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, getLevelDb]);

  const segMask =
    'repeating-linear-gradient(90deg, #000 0 calc(100%/28 - 3px), transparent calc(100%/28 - 3px) calc(100%/28))';
  return (
    <div
      className={cn('relative h-4 w-full', className)}
      role="meter"
      aria-label="Microphone level"
      data-testid="level-meter"
    >
      <div
        className="absolute inset-0 bg-zinc-800"
        style={{ maskImage: segMask, WebkitMaskImage: segMask }}
      />
      <div
        ref={barRef}
        className="absolute inset-0 bg-gradient-to-r from-emerald-400 via-fuchsia-500 to-orange-500"
        style={{ maskImage: segMask, WebkitMaskImage: segMask, clipPath: 'inset(0 100% 0 0)' }}
      />
      <div
        ref={peakRef}
        className="absolute inset-y-0 w-1 rounded-full bg-white/80"
        style={{ left: '-4px' }}
      />
      <div
        className="absolute -inset-y-1 w-px bg-white/40"
        style={{ left: `${dbToMeter(MIC_OK_THRESHOLD_DB) * 100}%` }}
        title="Detection threshold"
      />
    </div>
  );
}
