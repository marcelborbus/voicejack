import { formatClock, type FxId } from '@dub/shared';
import {
  Headphones,
  Pause,
  Play,
  Redo2,
  TimerOff,
  SkipBack,
  Square,
  Timer,
  Undo2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { serverNow } from '@/state/session';
import { formatPrecise, mediaNowMs, SPEEDS, transport, useEditor } from './editorStore';
import { FxPicker } from './FxPicker';

function Tip({
  label,
  keys,
  children,
}: {
  label: string;
  keys?: string[];
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="flex items-center gap-2">
        {label}
        {keys?.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}

/** Clicking a transport button must not leave focus on it (Space would click it again). */
const noFocus = (e: React.MouseEvent) => e.preventDefault();

export interface TransportProps {
  /** Record / stop. Absent → record button disabled. */
  onRecord?: () => void;
  onCancelRecord?: () => void;
  canRecord?: boolean;
  recordHint?: string;
  /** #48: effect picker (absent → no picker). */
  onPickFx?: (fx: FxId) => void;
  fxDisabled?: boolean;
}

export function Transport({
  onRecord,
  onCancelRecord,
  canRecord = true,
  recordHint,
  onPickFx,
  fxDisabled,
}: TransportProps) {
  const playing = useEditor((s) => s.playing);
  const speed = useEditor((s) => s.speed);
  const recording = useEditor((s) => s.recording);
  const durationMs = useEditor((s) => s.durationMs);
  const rec = recording !== null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
      <div className="flex items-center gap-1.5">
        <Tip label="Jump to start" keys={['Home']}>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Jump to start"
            disabled={rec}
            onMouseDown={noFocus}
            onClick={() => transport.seek(0)}
          >
            <SkipBack />
          </Button>
        </Tip>
        <Tip label="Back 5 s" keys={['←']}>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back 5 seconds"
            data-testid="back-5"
            disabled={rec}
            onMouseDown={noFocus}
            onClick={() => transport.nudge(-5000)}
          >
            <Undo2 />
          </Button>
        </Tip>
        <Tip label={playing ? 'Pause' : 'Play'} keys={['Space']}>
          <Button
            size="icon"
            data-testid="play-pause"
            aria-label={playing ? 'Pause' : 'Play'}
            aria-pressed={playing}
            disabled={rec}
            onMouseDown={noFocus}
            onClick={() => transport.toggle()}
            className="size-13 rounded-2xl [&_svg]:size-6"
          >
            {playing ? (
              <Pause fill="currentColor" />
            ) : (
              <Play fill="currentColor" className="translate-x-px" />
            )}
          </Button>
        </Tip>
        <Tip label="Forward 5 s" keys={['→']}>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Forward 5 seconds"
            data-testid="fwd-5"
            disabled={rec}
            onMouseDown={noFocus}
            onClick={() => transport.nudge(5000)}
          >
            <Redo2 />
          </Button>
        </Tip>
      </div>

      <TimeReadout durationMs={durationMs} />

      <div
        hidden={rec}
        role="radiogroup"
        aria-label="Preview speed"
        className="flex items-center rounded-2xl border border-white/[0.07] bg-white/[0.03] p-1"
      >
        {SPEEDS.map((s, i) => (
          <Tip key={s} label={`Preview at ${s}×`} keys={[String(i + 1)]}>
            <button
              type="button"
              role="radio"
              aria-checked={speed === s}
              data-testid={`speed-${s}`}
              disabled={rec}
              onMouseDown={noFocus}
              onClick={() => transport.setSpeed(s)}
              className={cn(
                'relative h-8 min-w-11 rounded-xl px-2 font-mono text-xs font-semibold tabular-nums transition-colors',
                'disabled:opacity-40',
                speed === s
                  ? 'bg-white/[0.12] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]'
                  : 'text-zinc-400 hover:text-zinc-100',
              )}
            >
              {s}×
            </button>
          </Tip>
        ))}
      </div>

      <div className="ml-auto flex items-center gap-2">
        {onPickFx && <FxPicker onPick={onPickFx} disabled={rec || fxDisabled} />}
        {rec && onCancelRecord && (
          <Tip label="Discard this take" keys={[]}>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Discard take"
              data-testid="record-cancel"
              onMouseDown={noFocus}
              onClick={onCancelRecord}
            >
              <X />
            </Button>
          </Tip>
        )}
        <Tip
          label={rec ? 'Stop recording' : (recordHint ?? 'Record from the cursor (always 1×)')}
          keys={rec ? ['R', 'Esc'] : ['R']}
        >
          <span tabIndex={-1}>
            <RecordButton
              recording={rec}
              arming={recording?.phase === 'arming'}
              disabled={!onRecord || (!rec && !canRecord) || recording?.phase === 'finishing'}
              onClick={() => onRecord?.()}
            />
          </span>
        </Tip>
      </div>
    </div>
  );
}

function RecordButton({
  recording,
  arming,
  disabled,
  onClick,
}: {
  recording: boolean;
  arming: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="record"
      aria-pressed={recording}
      disabled={disabled}
      onMouseDown={noFocus}
      onClick={onClick}
      className={cn(
        'group relative inline-flex h-13 items-center gap-2.5 rounded-2xl pl-3 pr-5 font-display text-base font-bold',
        'transition-[transform,background-color,box-shadow] duration-150 active:scale-[0.97]',
        'disabled:pointer-events-none disabled:opacity-45',
        recording
          ? 'bg-rose-500 text-white shadow-[0_0_0_4px_rgba(244,63,94,0.25),0_10px_30px_-8px_rgba(244,63,94,0.8)]'
          : 'bg-zinc-800 text-zinc-50 shadow-lg shadow-black/30 hover:bg-zinc-700/90 border border-white/5',
      )}
    >
      <span
        className={cn(
          'relative inline-flex size-8 items-center justify-center rounded-full',
          recording ? 'bg-white/20' : 'bg-rose-500/15',
        )}
      >
        {recording ? (
          <Square className="size-3.5" fill="currentColor" />
        ) : (
          <span className="size-3.5 rounded-full bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.8)] transition-transform group-hover:scale-110" />
        )}
        {recording && !arming && (
          // Static ring, no `animate-ping`: an infinite scale animation here cost Firefox most of
          // its frame rate while recording (#49).
          <span className="absolute inset-0 rounded-full ring-2 ring-white/40" />
        )}
      </span>
      {recording ? (arming ? 'Starting…' : 'Stop') : 'Record'}
    </button>
  );
}

/** `0:04.21 / 0:12.00`, updated per frame without re-rendering React. */
function TimeReadout({ durationMs }: { durationMs: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let last = '';
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const txt = formatPrecise(mediaNowMs());
      if (txt !== last && ref.current) ref.current.textContent = last = txt;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div
      className="flex items-baseline gap-1.5 rounded-2xl bg-black/30 px-3.5 py-2 font-mono tabular-nums"
      data-testid="time-readout"
    >
      <span ref={ref} className="text-lg font-semibold text-zinc-50">
        0:00.00
      </span>
      <span className="text-sm text-zinc-500">/ {formatPrecise(durationMs)}</span>
    </div>
  );
}

/** Reference (original) audio on/off + volume, with the headphones hint. */
export function ReferenceAudio() {
  const on = useEditor((s) => s.refAudio);
  const vol = useEditor((s) => s.refVolume);
  return (
    <div className="flex flex-col gap-3" data-testid="ref-audio">
      <div className="flex items-center gap-3">
        <Tip label={on ? 'Mute original audio' : 'Hear original audio'} keys={['M']}>
          <Button
            variant={on ? 'secondary' : 'outline'}
            size="icon"
            aria-pressed={on}
            aria-label="Original audio"
            data-testid="ref-toggle"
            onMouseDown={noFocus}
            onClick={() => transport.setRefAudio(!on)}
          >
            {on ? <Volume2 /> : <VolumeX />}
          </Button>
        </Tip>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-zinc-300">Original audio</span>
            <span className="font-mono tabular-nums text-zinc-500">
              {on ? `${Math.round(vol * 100)}%` : 'off'}
            </span>
          </div>
          <Slider
            aria-label="Original audio volume"
            data-testid="ref-volume"
            min={0}
            max={1}
            step={0.01}
            value={[on ? vol : 0]}
            onValueChange={([v]) => transport.setRefVolume(v ?? 0)}
            className="py-1"
            thumbClassName="size-4 border-2"
          />
        </div>
      </div>
      <p className="flex items-start gap-2 text-xs leading-relaxed text-zinc-500">
        <Headphones className="mt-0.5 size-3.5 shrink-0 text-fuchsia-300" />
        Use headphones, so the original sound and your other takes don't end up in your recording.
      </p>
    </div>
  );
}

/** Dubbing deadline from `phaseEndsAt` (server clock). */
export function Countdown({ endsAt, onExpire }: { endsAt: number | null; onExpire?: () => void }) {
  const [left, setLeft] = useState(() => (endsAt === null ? 0 : endsAt - serverNow()));
  const fired = useRef(false);
  useEffect(() => {
    fired.current = false;
    if (endsAt === null) return;
    const tick = () => {
      const l = endsAt - serverNow();
      setLeft(l);
      if (l <= 0 && !fired.current) {
        fired.current = true;
        onExpire?.();
      }
    };
    tick();
    const iv = setInterval(tick, 200);
    return () => clearInterval(iv);
  }, [endsAt, onExpire]);

  const over = left <= 0;
  const urgent = !over && left <= 10_000;
  const warn = !over && left <= 30_000;
  return (
    <div
      data-testid="countdown"
      data-ms-left={Math.max(0, Math.round(left))}
      className={cn(
        'flex items-center gap-2 rounded-2xl border px-3.5 py-2 font-mono text-xl font-bold tabular-nums transition-colors',
        over
          ? 'border-white/10 bg-zinc-800/60 text-zinc-400'
          : urgent
            ? 'animate-blink border-rose-500/40 bg-rose-500/15 text-rose-200'
            : warn
              ? 'border-amber-400/30 bg-amber-400/10 text-amber-200'
              : 'border-white/[0.08] bg-white/[0.04] text-zinc-50',
      )}
    >
      {over ? <TimerOff className="size-5" /> : <Timer className="size-5 opacity-70" />}
      {over ? "Time's up" : formatClock(left, 'ceil')}
    </div>
  );
}
