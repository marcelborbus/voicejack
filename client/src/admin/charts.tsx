import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * V15 admin charts: inline SVG, no chart library or CDN. Single-hue (sequential blue, validated
 * against the ink-900 surface with the dataviz validator: L/chroma/contrast pass). Text uses the
 * zinc text tokens, never the series colour. Thin marks: ≤ 24 px bars with a 4 px rounded data
 * end, square at the baseline; hairline solid gridlines; hover tooltip on every mark.
 */
export const VIZ = {
  series: '#3987e5',
  seriesHover: '#5598e7',
  grid: 'rgb(255 255 255 / 0.08)',
  surface: '#170f28',
} as const;

export function compact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= v) return m * mag;
  return 10 * mag;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Path of a column with a 4 px rounded top and a square base. */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Path of a bar growing right from x0, rounded at its right (data) end. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, h / 2, w);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

function Tooltip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-white/10 bg-ink-950 px-2.5 py-1.5 text-xs text-zinc-100 shadow-lg"
      style={{ left: x, top: y - 8 }}
    >
      {children}
    </div>
  );
}

/** One series over days (columns). The title names the series, so no legend. */
export function ColumnChart({
  data,
  label,
  height = 160,
  testId,
}: {
  data: { key: string; value: number }[];
  label: string;
  height?: number;
  testId?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const padL = 32;
  const padB = 20;
  const padT = 8;
  const plotW = Math.max(10, width - padL);
  const plotH = height - padB - padT;
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const band = plotW / Math.max(1, data.length);
  const colW = Math.max(2, Math.min(24, band - 2)); // 2 px surface gap between neighbours
  const ticks = [0, max / 2, max];
  const every = Math.ceil(data.length / Math.max(1, Math.floor(plotW / 56)));
  const h = hover !== null ? data[hover] : undefined;
  return (
    <div ref={ref} className="relative w-full" data-testid={testId}>
      <svg width={width} height={height} role="img" aria-label={label} className="block">
        {ticks.map((t) => {
          const y = padT + plotH - (t / max) * plotH;
          return (
            <g key={t}>
              <line x1={padL} x2={width} y1={y} y2={y} stroke={VIZ.grid} strokeWidth={1} />
              <text
                x={padL - 6}
                y={y}
                dy="0.32em"
                textAnchor="end"
                className="fill-zinc-500 text-[10px] tabular-nums"
              >
                {compact(t)}
              </text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const x = padL + i * band + (band - colW) / 2;
          const ch = (d.value / max) * plotH;
          return (
            <g key={d.key}>
              {ch > 0 && (
                <path
                  d={columnPath(x, padT + plotH - ch, colW, ch)}
                  fill={hover === i ? VIZ.seriesHover : VIZ.series}
                />
              )}
              {i % every === 0 && (
                <text
                  x={padL + i * band + band / 2}
                  y={height - 4}
                  textAnchor="middle"
                  className="fill-zinc-500 text-[10px]"
                >
                  {d.key.slice(5)}
                </text>
              )}
              {/* Hit target: the whole band, taller than the mark. */}
              <rect
                x={padL + i * band}
                y={padT}
                width={band}
                height={plotH}
                fill="transparent"
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover((c) => (c === i ? null : c))}
              />
            </g>
          );
        })}
      </svg>
      {h && hover !== null && (
        <Tooltip x={padL + hover * band + band / 2} y={padT + plotH - (h.value / max) * plotH}>
          <span className="text-zinc-400">{h.key}</span> · <strong>{h.value}</strong> {label}
        </Tooltip>
      )}
    </div>
  );
}

/**
 * Horizontal bars for a ranked or ordered list (funnel, drop-off, breakdowns). Value at the
 * bar tip; optional secondary note (e.g. % of the first step).
 */
export function BarList({
  rows,
  label,
  note,
  testId,
  empty = 'No data yet.',
}: {
  rows: { key: string; label?: string; value: number }[];
  label: string;
  note?: (row: { key: string; value: number }, i: number) => string | null;
  testId?: string;
  empty?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (rows.length === 0 || rows.every((r) => r.value === 0)) {
    return (
      <p className="text-sm text-zinc-500" data-testid={testId}>
        {empty}
      </p>
    );
  }
  const labelW = Math.min(130, Math.max(100, width * 0.35));
  const valueW = 72;
  const rowH = 30;
  const barH = 18;
  const plotW = Math.max(10, width - labelW - valueW);
  const max = Math.max(1, ...rows.map((r) => r.value));
  const height = rows.length * rowH;
  return (
    <div ref={ref} className="relative w-full" data-testid={testId}>
      <svg width={width} height={height} role="img" aria-label={label} className="block">
        <line x1={labelW} x2={labelW} y1={0} y2={height} stroke={VIZ.grid} strokeWidth={1} />
        {rows.map((r, i) => {
          const y = i * rowH + (rowH - barH) / 2;
          const w = (r.value / max) * plotW;
          const n = note?.(r, i);
          return (
            <g
              key={r.key}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover((c) => (c === i ? null : c))}
            >
              <rect x={0} y={i * rowH} width={width} height={rowH} fill="transparent" />
              <text
                x={labelW - 8}
                y={y + barH / 2}
                dy="0.32em"
                textAnchor="end"
                className="fill-zinc-300 text-[12px]"
              >
                {(r.label ?? r.key).length > 18
                  ? `${(r.label ?? r.key).slice(0, 17)}…`
                  : (r.label ?? r.key)}
              </text>
              {w > 0 && (
                <path
                  d={barPath(labelW, y, w, barH)}
                  fill={hover === i ? VIZ.seriesHover : VIZ.series}
                />
              )}
              <text
                x={labelW + w + 6}
                y={y + barH / 2}
                dy="0.32em"
                className="fill-zinc-100 text-[12px] font-semibold tabular-nums"
              >
                {compact(r.value)}
                {n && <tspan className="fill-zinc-500 font-normal"> {n}</tspan>}
              </text>
            </g>
          );
        })}
      </svg>
      {hover !== null && rows[hover] && (
        <Tooltip x={labelW + plotW / 2} y={hover * rowH + 4}>
          {rows[hover]!.label ?? rows[hover]!.key}: <strong>{rows[hover]!.value}</strong> {label}
        </Tooltip>
      )}
    </div>
  );
}

/** Stat tile: label, value, optional sub line. */
export function StatTile({
  label,
  value,
  sub,
  testId,
}: {
  label: string;
  value: string;
  sub?: string;
  testId?: string;
}) {
  return (
    <div
      className="flex flex-col gap-1 rounded-2xl border border-white/[0.06] bg-white/[0.02] px-4 py-3"
      data-testid={testId}
    >
      <span className="text-xs text-zinc-400">{label}</span>
      <span className="font-display text-2xl font-bold text-zinc-50">{value}</span>
      {sub && <span className="text-xs text-zinc-500">{sub}</span>}
    </div>
  );
}

/** Heat cell for the cohort table: blue at `share` opacity over the surface, label in ink. */
export function HeatCell({ share, children }: { share: number | null; children: ReactNode }) {
  const a = share === null ? 0 : Math.max(0.06, Math.min(1, share));
  return (
    <td
      className={cn(
        'px-2 py-1.5 text-center text-xs tabular-nums',
        a > 0.55 ? 'text-white' : 'text-zinc-200',
      )}
      style={{ background: share === null ? 'transparent' : `rgb(57 135 229 / ${a})` }}
    >
      {children}
    </td>
  );
}
