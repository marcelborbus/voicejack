import { laneCount, layoutLanes } from '@dub/shared';
import { Layers, Minus, Plus, Scan } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { getMicLevelDb } from '@/audio/mic';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ChunkBlock, RecordingBlock } from './ChunkBlock';
import { media, mediaNowMs, transport, useEditor, ZOOMS, editorStore } from './editorStore';

const LANE_H = 52;
const RULER_H = 30;
const PAD = 14; // px of breathing room left of 0 and right of the clip end
const MIN_LANES = 2;

const TICK_STEPS = [100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000];

function pickStep(pxPerMs: number): number {
  return TICK_STEPS.find((s) => s * pxPerMs >= 64) ?? 60_000;
}

function tickLabel(ms: number, step: number): string {
  const s = ms / 1000;
  if (step < 1000) return `${s.toFixed(step < 500 ? 2 : 1)}`;
  const m = Math.floor(s / 60);
  const ss = Math.round(s % 60);
  return m > 0 ? `${m}:${String(ss).padStart(2, '0')}` : `${ss}s`;
}

export interface TimelineProps {
  onRetry?: (id: string) => void;
}

/**
 * DOM timeline (§2.3): ruler, playhead, scrub by click/drag, lanes from `layoutLanes`,
 * waveform blocks, selection. The playhead is animated outside React (rAF) from the audio
 * clock so it glides at any speed.
 */
export function Timeline({ onRetry }: TimelineProps) {
  const durationMs = useEditor((s) => s.durationMs);
  const chunks = useEditor((s) => s.chunks);
  const selectedId = useEditor((s) => s.selectedId);
  const zoom = useEditor((s) => s.zoom);
  const recording = useEditor((s) => s.recording);

  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(0);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const contentW = Math.max(viewW, 0) * zoom;
  const pxPerMs = durationMs > 0 && contentW > 0 ? (contentW - 2 * PAD) / durationMs : 0;

  // Lanes. While recording, the take is laid out as if it ran to the clip end, so nothing
  // jumps between lanes as it grows.
  const { lanes, recLane, nLanes } = useMemo(() => {
    const items = chunks
      .filter((c) => !(recording?.replacingId && c.meta.id === recording.replacingId))
      .map((c) => ({ id: c.meta.id, startMs: c.meta.startMs, durationMs: c.meta.durationMs }));
    if (recording)
      items.push({ id: '￿_rec', startMs: recording.startMs, durationMs: durationMs - recording.startMs });
    const l = layoutLanes(items);
    // The take being replaced keeps a row of its own beneath (dimmed).
    if (recording?.replacingId) l.set(recording.replacingId, laneCount(l));
    return { lanes: l, recLane: l.get('￿_rec') ?? 0, nLanes: laneCount(l) };
  }, [chunks, recording, durationMs]);
  const shownLanes = Math.max(MIN_LANES, nLanes + (recording ? 0 : 1));

  // ---- playhead animation + follow ----
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const ms = mediaNowMs();
      const x = PAD + ms * pxPerMs;
      if (playheadRef.current) playheadRef.current.style.transform = `translate3d(${x}px,0,0)`;
      if (progressRef.current) progressRef.current.style.width = `${Math.max(0, x - PAD)}px`;
      const el = scrollRef.current;
      const v = media.video;
      if (el && zoom > 1 && v && !v.paused && media.scrubMs === null) {
        const w = el.clientWidth;
        if (x > el.scrollLeft + w * 0.85 || x < el.scrollLeft) el.scrollLeft = x - w * 0.2;
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [pxPerMs, zoom]);

  // ---- scrubbing ----
  const scrub = useRef<{ wasPlaying: boolean; id: number } | null>(null);
  const msAt = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el || pxPerMs <= 0) return 0;
      const r = el.getBoundingClientRect();
      const x = clientX - r.left + el.scrollLeft - PAD;
      return Math.max(0, Math.min(durationMs, x / pxPerMs));
    },
    [pxPerMs, durationMs],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || transport.isRecording()) return;
    const v = media.video;
    e.currentTarget.setPointerCapture(e.pointerId);
    const wasPlaying = !!v && !v.paused;
    if (wasPlaying) v!.pause();
    scrub.current = { wasPlaying, id: e.pointerId };
    transport.select(null);
    const ms = msAt(e.clientX);
    media.scrubMs = ms;
    transport.seek(ms);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!scrub.current || scrub.current.id !== e.pointerId) return;
    const ms = msAt(e.clientX);
    media.scrubMs = ms;
    transport.seek(ms);
  };
  const endScrub = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = scrub.current;
    if (!s || s.id !== e.pointerId) return;
    scrub.current = null;
    media.scrubMs = null;
    if (s.wasPlaying) transport.play();
  };

  // Ctrl/⌘ + wheel zooms around the pointer; plain vertical wheel scrolls horizontally when zoomed.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const z = editorStore.get().zoom;
        const i = ZOOMS.indexOf(z as (typeof ZOOMS)[number]);
        const next = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + (e.deltaY < 0 ? 1 : -1)))]!;
        if (next !== z) setZoomAround(next, e.clientX);
      } else if (editorStore.get().zoom > 1 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  const setZoomAround = (next: number, clientX?: number) => {
    const el = scrollRef.current;
    const cur = editorStore.get().zoom;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const anchorX =
      clientX !== undefined ? clientX - r.left : PAD + mediaNowMs() * pxPerMs - el.scrollLeft;
    const contentX = el.scrollLeft + anchorX;
    editorStore.set((s) => ({ ...s, zoom: next }));
    requestAnimationFrame(() => {
      el.scrollLeft = contentX * (next / cur) - anchorX;
    });
  };

  const ticks = useMemo(() => {
    if (pxPerMs <= 0) return [];
    const step = pickStep(pxPerMs);
    const minor = step / (step === 2000 ? 4 : 5);
    const out: { ms: number; major: boolean }[] = [];
    for (let ms = 0; ms <= durationMs + 0.5; ms += minor) {
      const major = Math.abs(ms / step - Math.round(ms / step)) < 1e-6;
      out.push({ ms, major });
    }
    return out.map((t) => ({ ...t, label: t.major ? tickLabel(t.ms, step) : null }));
  }, [pxPerMs, durationMs]);

  const zoomIdx = ZOOMS.indexOf(zoom as (typeof ZOOMS)[number]);
  const height = RULER_H + shownLanes * LANE_H;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Layers className="size-4 text-fuchsia-300" />
          <span>
            <span className="font-semibold text-zinc-200">Your dub</span>
            <span className="hidden sm:inline">
              {' '}
              · click or drag to move the cursor · overlapping takes stack as layers
            </span>
          </span>
        </div>
        <div className="flex items-center gap-1" aria-label="Zoom">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Zoom out"
                disabled={zoomIdx <= 0}
                onClick={() => setZoomAround(ZOOMS[Math.max(0, zoomIdx - 1)]!)}
              >
                <Minus />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Zoom out (Ctrl + wheel)</TooltipContent>
          </Tooltip>
          <span className="w-8 text-center font-mono text-xs tabular-nums text-zinc-400">{zoom}×</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Zoom in"
            disabled={zoomIdx >= ZOOMS.length - 1}
            onClick={() => setZoomAround(ZOOMS[Math.min(ZOOMS.length - 1, zoomIdx + 1)]!)}
          >
            <Plus />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Fit whole clip"
            disabled={zoom === 1}
            onClick={() => setZoomAround(1)}
          >
            <Scan />
          </Button>
        </div>
      </div>

      <div
        ref={scrollRef}
        data-testid="timeline"
        className={cn(
          'relative overflow-x-auto overflow-y-hidden rounded-2xl border border-white/[0.07] bg-zinc-950/60',
          '[scrollbar-color:rgba(255,255,255,0.15)_transparent] [scrollbar-width:thin]',
          recording ? 'cursor-not-allowed' : 'cursor-text',
        )}
        style={{ height: height + 2 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
      >
        <div className="relative select-none" style={{ width: contentW || '100%', height }}>
          {/* ruler */}
          <div
            className="absolute inset-x-0 top-0 border-b border-white/[0.07] bg-white/[0.025]"
            style={{ height: RULER_H }}
          >
            <div
              ref={progressRef}
              className="absolute bottom-0 h-0.5 bg-gradient-to-r from-fuchsia-500/0 via-fuchsia-500/50 to-fuchsia-400"
              style={{ left: PAD }}
            />
            {ticks.map((t) => (
              <div
                key={t.ms}
                className={cn(
                  'absolute bottom-0 w-px',
                  t.major ? 'h-2.5 bg-zinc-500' : 'h-1.5 bg-zinc-700',
                )}
                style={{ left: PAD + t.ms * pxPerMs }}
              >
                {t.label && (
                  <span className="absolute bottom-3 left-0 -translate-x-1/2 font-mono text-[10px] tabular-nums text-zinc-500">
                    {t.label}
                  </span>
                )}
              </div>
            ))}
          </div>

          {/* lanes */}
          <div className="absolute inset-x-0" style={{ top: RULER_H, height: shownLanes * LANE_H }}>
            {Array.from({ length: shownLanes }, (_, i) => (
              <div
                key={i}
                className={cn(
                  'absolute inset-x-0 border-b border-white/[0.04]',
                  i % 2 === 1 && 'bg-white/[0.012]',
                )}
                style={{ top: i * LANE_H, height: LANE_H }}
              />
            ))}
            {/* clip bounds */}
            <div
              className="absolute inset-y-0 border-l border-dashed border-white/10"
              style={{ left: PAD + durationMs * pxPerMs }}
            />
            {chunks.length === 0 && !recording && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-500">
                Nothing recorded yet. Move the cursor, then hit <span className="mx-1.5 rounded-md bg-rose-500/15 px-1.5 font-semibold text-rose-300">Record</span> or press R.
              </div>
            )}
            <div className="absolute inset-y-0" style={{ left: PAD, right: PAD }}>
              {pxPerMs > 0 &&
                chunks.map((c) => (
                  <ChunkBlock
                    key={c.meta.id}
                    chunk={c}
                    lane={lanes.get(c.meta.id) ?? 0}
                    laneH={LANE_H}
                    pxPerMs={pxPerMs}
                    selected={c.meta.id === selectedId}
                    dimmed={recording?.replacingId === c.meta.id}
                    onSelect={transport.select}
                    onPlayFrom={transport.playFrom}
                    onRetry={onRetry}
                  />
                ))}
              {recording && recording.phase !== 'finishing' && pxPerMs > 0 && (
                <RecordingBlock
                  startMs={recording.startMs}
                  lane={recLane}
                  laneH={LANE_H}
                  pxPerMs={pxPerMs}
                  maxMs={durationMs - recording.startMs}
                  nowMs={recording.phase === 'recording' ? mediaNowMs : recStartNow(recording.startMs)}
                  levelDb={getMicLevelDb}
                />
              )}
            </div>
          </div>

          {/* playhead */}
          <div
            ref={playheadRef}
            data-testid="playhead"
            className="pointer-events-none absolute left-0 top-0 z-30 will-change-transform"
            style={{ height }}
          >
            <div
              className={cn(
                'absolute -left-[7px] top-0 h-3.5 w-3.5 rounded-b-md rounded-t-sm shadow-lg',
                recording ? 'bg-rose-500 shadow-rose-500/60' : 'bg-white shadow-fuchsia-500/50',
              )}
            />
            <div
              className={cn(
                'absolute -left-px top-0 h-full w-0.5',
                recording ? 'bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.9)]' : 'bg-white/90 shadow-[0_0_8px_rgba(255,255,255,0.5)]',
              )}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

const recStartCache = new Map<number, () => number>();
/** Stable "now" while arming: the take has not started yet. */
function recStartNow(ms: number): () => number {
  let f = recStartCache.get(ms);
  if (!f) {
    f = () => ms;
    recStartCache.clear();
    recStartCache.set(ms, f);
  }
  return f;
}
