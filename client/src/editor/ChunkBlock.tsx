import { FX_INFO } from '@dub/shared';
import { AlertTriangle, Check, CloudUpload, Loader2, RotateCw } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useRef, type PointerEvent } from 'react';
import { PEAKS_PER_SEC } from '@/dub/chunkLoader';
import { cn } from '@/lib/utils';
import { formatPrecise, formatSeconds, type EditorChunk } from './editorStore';
import { RecordingBars } from './recordingBars';

/** Take colours: [from, to] of the block gradient. Picked by take number. */
const PALETTE: [string, string][] = [
  ['#d946ef', '#ec4899'], // fuchsia → pink
  ['#f97316', '#f59e0b'], // orange → amber
  ['#8b5cf6', '#d946ef'], // violet → fuchsia
  ['#ec4899', '#f97316'], // pink → orange
  ['#06b6d4', '#8b5cf6'], // cyan → violet
  ['#10b981', '#06b6d4'], // emerald → cyan
];
export const takeColors = (take: number) => PALETTE[(take - 1) % PALETTE.length]!;

const MAX_CANVAS_PX = 8192;

/** Mirrored bar waveform from per-10 ms peaks; `fromMs`/`spanMs` select the audible part. */
export function drawPeaks(
  canvas: HTMLCanvasElement,
  peaks: ArrayLike<number>,
  fromMs: number,
  spanMs: number,
  color = 'rgba(255,255,255,0.86)',
): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  const w = Math.max(1, Math.min(MAX_CANVAS_PX, Math.round(cssW * dpr)));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, w, h);
  if (spanMs <= 0 || peaks.length === 0) return;
  g.fillStyle = color;
  const bar = Math.max(1, Math.round(2 * dpr));
  const gap = Math.max(1, Math.round(1 * dpr));
  const mid = h / 2;
  const perPx = spanMs / w; // ms per device px
  for (let x = 0; x < w; x += bar + gap) {
    const a = Math.floor(((fromMs + x * perPx) * PEAKS_PER_SEC) / 1000);
    const b = Math.max(a + 1, Math.ceil(((fromMs + (x + bar) * perPx) * PEAKS_PER_SEC) / 1000));
    let p = 0;
    for (let i = a; i < b && i < peaks.length; i++) p = Math.max(p, peaks[i]!);
    // Gentle compression so quiet speech is still visible.
    const v = Math.sqrt(p);
    const bh = Math.max(dpr, v * (h - 2 * dpr));
    g.fillRect(x, mid - bh / 2, bar, bh);
  }
}

export interface ChunkBlockProps {
  chunk: EditorChunk;
  lane: number;
  laneH: number;
  pxPerMs: number;
  selected: boolean;
  /** Muted while it is being re-recorded. */
  dimmed?: boolean;
  onSelect: (id: string) => void;
  onPlayFrom: (ms: number) => void;
  onRetry?: (id: string) => void;
}

export const ChunkBlock = memo(function ChunkBlock({
  chunk,
  lane,
  laneH,
  pxPerMs,
  selected,
  dimmed,
  onSelect,
  onPlayFrom,
  onRetry,
}: ChunkBlockProps) {
  const { meta, status, peaks, take } = chunk;
  const fx = meta.fx && meta.fx !== 'none' ? FX_INFO[meta.fx] : null;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const left = meta.startMs * pxPerMs;
  const width = Math.max(4, meta.durationMs * pxPerMs);
  const [from, to] = takeColors(take);
  const narrow = width < 64;

  useLayoutEffect(() => {
    const c = canvasRef.current;
    if (c && peaks) drawPeaks(c, peaks, meta.offsetMs, meta.durationMs);
  }, [peaks, meta.offsetMs, meta.durationMs, width, laneH]);

  const down = (e: PointerEvent) => {
    e.stopPropagation(); // don't scrub
    if (e.button === 0) onSelect(meta.id);
  };

  return (
    <div
      role="button"
      tabIndex={-1}
      data-testid="chunk-block"
      data-chunk-id={meta.id}
      data-status={status}
      data-lane={lane}
      data-fx={meta.fx ?? 'none'}
      data-selected={selected || undefined}
      aria-label={`Take ${take}, ${formatPrecise(meta.startMs)}, ${formatSeconds(meta.durationMs)}${fx ? `, ${fx.name}` : ''}`}
      title={`Take ${take} · ${formatPrecise(meta.startMs)} – ${formatPrecise(meta.startMs + meta.durationMs)}${fx ? ` · ${fx.emoji} ${fx.name}` : ''}`}
      onPointerDown={down}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onPlayFrom(meta.startMs);
      }}
      className={cn(
        'group absolute overflow-hidden rounded-xl text-white',
        'transition-[box-shadow,opacity,filter] duration-150 animate-[pop_300ms_cubic-bezier(0.34,1.56,0.64,1)_both]',
        selected
          ? 'z-10 shadow-[0_0_0_2px_#fff,0_8px_28px_-6px_rgba(217,70,239,0.7)]'
          : 'shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] hover:brightness-110',
        dimmed && 'opacity-30 saturate-50',
        status === 'restoring' && 'animate-pulse',
        status === 'failed' && 'shadow-[0_0_0_2px_#f43f5e]',
      )}
      style={{
        left,
        width,
        top: lane * laneH + 4,
        height: laneH - 8,
        backgroundImage: `linear-gradient(135deg, ${from}, ${to})`,
      }}
    >
      {/* soft top highlight */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/20 via-transparent to-black/20" />
      {peaks ? (
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute inset-x-1 inset-y-1.5 h-[calc(100%-12px)] w-[calc(100%-8px)]"
        />
      ) : (
        <div className="absolute inset-x-2 top-1/2 h-px bg-white/40" />
      )}
      {!narrow && (
        // No backdrop-blur here: a blurred label per take, next to the growing recording block,
        // re-sampled the timeline every frame and froze Firefox again from the second take on (#49).
        <span className="pointer-events-none absolute left-2 top-1 rounded-md bg-black/35 px-1.5 text-[10px] font-bold leading-4 tracking-wide">
          {take}
          {fx && (
            <span className="ml-1 text-[11px]" data-testid="chunk-fx">
              {fx.emoji}
            </span>
          )}
        </span>
      )}
      {narrow && fx && (
        <span
          className="pointer-events-none absolute left-0.5 top-0.5 text-[10px] leading-none"
          data-testid="chunk-fx"
        >
          {fx.emoji}
        </span>
      )}
      <StatusIcon
        status={status}
        narrow={narrow}
        onRetry={onRetry ? () => onRetry(meta.id) : undefined}
      />
    </div>
  );
});

function StatusIcon({
  status,
  narrow,
  onRetry,
}: {
  status: EditorChunk['status'];
  narrow: boolean;
  onRetry?: () => void;
}) {
  if (status === 'failed') {
    return (
      <button
        type="button"
        data-testid="chunk-retry"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onRetry?.();
        }}
        title="Upload failed. Retry"
        className="absolute right-1 top-1 inline-flex h-5 items-center gap-1 rounded-md bg-rose-600 px-1.5 text-[10px] font-bold shadow"
      >
        <AlertTriangle className="size-3" />
        {!narrow && <RotateCw className="size-3" />}
      </button>
    );
  }
  if (narrow) return null;
  const cls = 'pointer-events-none absolute right-1.5 top-1.5 size-3.5 drop-shadow';
  if (status === 'uploading')
    return <CloudUpload className={cn(cls, 'animate-blink opacity-90')} aria-label="Uploading" />;
  if (status === 'restoring')
    return <Loader2 className={cn(cls, 'animate-spin')} aria-label="Restoring" />;
  return (
    <Check
      className={cn(cls, 'opacity-0 transition-opacity group-hover:opacity-80')}
      strokeWidth={3}
      aria-label="Saved"
    />
  );
}

/**
 * The take being recorded: grows with the playhead and draws the live mic level.
 * `nowMs()` and `levelDb()` are polled per animation frame.
 *
 * Cheap per frame on purpose (Firefox froze here, #49): the canvas is sized once for the whole
 * possible take and only the new bars are drawn (no per-frame canvas resize, no layout reads),
 * the box only changes width when it grows by a whole pixel, and it has no blurred glow (a
 * box-shadow blur on a box that resizes every frame is re-rasterised every frame).
 */
export function RecordingBlock({
  startMs,
  lane,
  laneH,
  pxPerMs,
  maxMs,
  nowMs,
  levelDb,
}: {
  startMs: number;
  lane: number;
  laneH: number;
  pxPerMs: number;
  maxMs: number;
  nowMs: () => number;
  levelDb: () => number;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const spanMs = Math.max(0, maxMs);
  const canvasCssW = Math.max(1, spanMs * pxPerMs - 8);
  const canvasCssH = Math.max(1, laneH - 8 - 12);

  useEffect(() => {
    const box = boxRef.current;
    const c = canvasRef.current;
    if (!box || !c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.min(MAX_CANVAS_PX, Math.round(canvasCssW * dpr)));
    const h = Math.max(1, Math.round(canvasCssH * dpr));
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    const bars = new RecordingBars(spanMs, w, h, dpr);
    let raf = 0;
    let lastWidth = -1;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const dur = Math.max(0, Math.min(spanMs, nowMs() - startMs));
      const width = Math.max(6, Math.round(dur * pxPerMs));
      if (width !== lastWidth) {
        box.style.width = `${width}px`;
        lastWidth = width;
      }
      const db = levelDb();
      bars.push(dur, Math.max(0, Math.min(1, Math.pow(10, db / 20) * 2.2)));
      if (g) {
        g.fillStyle = 'rgba(255,255,255,0.9)';
        bars.drawNew(dur, (x, y, bw, bh) => g.fillRect(x, y, bw, bh));
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [startMs, pxPerMs, spanMs, canvasCssW, canvasCssH, nowMs, levelDb]);

  return (
    <div
      ref={boxRef}
      data-testid="recording-block"
      className="pointer-events-none absolute z-20 overflow-hidden rounded-xl bg-gradient-to-r from-rose-600 to-rose-500 shadow-[0_0_0_2px_rgba(255,255,255,0.9)]"
      style={{ left: startMs * pxPerMs, top: lane * laneH + 4, height: laneH - 8, width: 6 }}
    >
      <canvas
        ref={canvasRef}
        className="absolute left-1 top-1.5"
        style={{ width: canvasCssW, height: canvasCssH }}
      />
      <span className="absolute left-2 top-1 flex items-center gap-1 text-[10px] font-black tracking-widest">
        <span className="size-1.5 animate-blink rounded-full bg-white" /> REC
      </span>
    </div>
  );
}
