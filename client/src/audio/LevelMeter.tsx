import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { dbToMeter, MIC_OK_THRESHOLD_DB } from './levels';
import { getMicLevelDb } from './mic';

const SEGMENTS = 28;

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
    // #50: the meter is 28 segments, so only touch the DOM when the lit segment count (or the
    // peak's segment) changes. Writing clip-path / left every frame re-rasterised the masked
    // bar and re-ran layout 60 times a second, even in silence.
    let litShown = -1;
    let litPeak = -1;
    const loop = (t: number) => {
      const v = dbToMeter(getLevelDb());
      // fast attack, slower release
      shown = v > shown ? v : shown + (v - shown) * 0.18;
      if (shown >= peak || t - peakAt > 900) {
        peak = shown;
        peakAt = t;
      }
      const ls = Math.round(shown * SEGMENTS);
      const lp = Math.round(peak * SEGMENTS);
      if (ls !== litShown && barRef.current) {
        barRef.current.style.clipPath = `inset(0 ${(1 - ls / SEGMENTS) * 100}% 0 0)`;
        litShown = ls;
      }
      if (lp !== litPeak && peakRef.current) {
        peakRef.current.style.left = `calc(${(lp / SEGMENTS) * 100}% - 2px)`;
        litPeak = lp;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, getLevelDb]);

  const segMask = `repeating-linear-gradient(90deg, #000 0 calc(100%/${SEGMENTS} - 3px), transparent calc(100%/${SEGMENTS} - 3px) calc(100%/${SEGMENTS}))`;
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
