import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import './results.css';

/** Counts from `from` to `to` over `ms` once `start` is true (ease-out). */
export function useCountUp(to: number, { from = 0, ms = 900, start = true } = {}): number {
  const [v, setV] = useState(from);
  useEffect(() => {
    if (!start) {
      setV(from);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      setV(Math.round(from + (to - from) * e));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, from, ms, start]);
  return v;
}

export function CountUp({
  to,
  from = 0,
  ms,
  start = true,
  prefix = '',
}: {
  to: number;
  from?: number;
  ms?: number;
  start?: boolean;
  prefix?: string;
}) {
  const v = useCountUp(to, { from, ms, start });
  return (
    <span className="tabular-nums">
      {prefix}
      {v}
    </span>
  );
}

const COLORS = ['#d946ef', '#ec4899', '#f97316', '#facc15', '#22d3ee', '#a78bfa', '#34d399'];

/** A one-shot burst of CSS confetti. */
export function Confetti({ pieces = 90, seed = 1 }: { pieces?: number; seed?: number }) {
  // Unmounted once the burst is over, so nothing keeps compositing afterwards.
  const [live, setLive] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setLive(false), 6500);
    return () => clearTimeout(t);
  }, []);
  const items = useMemo(() => {
    let s = seed * 9301 + 49297;
    const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    return Array.from({ length: pieces }, (_, i) => {
      const w = 6 + rnd() * 8;
      return {
        key: i,
        style: {
          left: `${rnd() * 100}%`,
          width: `${w}px`,
          height: `${w * (0.4 + rnd() * 0.8)}px`,
          background: COLORS[Math.floor(rnd() * COLORS.length)],
          '--delay': `${rnd() * 1.4}s`,
          '--dur': `${2.6 + rnd() * 2.2}s`,
          '--drift': `${(rnd() - 0.5) * 240}px`,
          '--spin': `${(rnd() > 0.5 ? 1 : -1) * (360 + rnd() * 900)}deg`,
        } as CSSProperties,
      };
    });
  }, [pieces, seed]);
  if (!live) return null;
  return (
    <div className="dub-confetti" aria-hidden data-testid="confetti">
      {items.map((p) => (
        <i key={p.key} style={p.style} />
      ))}
    </div>
  );
}
