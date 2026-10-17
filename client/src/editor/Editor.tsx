import type { ClipInfo } from '@dub/shared';
import { Check, CirclePlay, Gauge, Hourglass, Keyboard, Mic, Play, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { getAudioContext } from '@/audio/context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { DubPlayer, type DubChunk } from '@/dub/DubPlayer';
import { cn } from '@/lib/utils';
import {
  deleteChunk,
  editorStore,
  flushPendingSeek,
  formatPrecise,
  formatSeconds,
  media,
  resetFor,
  transport,
  useEditor,
  type EditorChunk,
} from './editorStore';
import { Timeline } from './Timeline';
import { Countdown, ReferenceAudio, Transport } from './Transport';
import { useEditorKeys } from './useEditorKeys';

export interface EditorProps {
  clip: ClipInfo;
  /** `code:round:submissionId`. */
  editorKey: string;
  roundLabel: string;
  phaseEndsAt: number | null;
  done: boolean;
  /** Done was clicked; finishing the take / uploads first. */
  doneBusy?: boolean;
  doneCount: { done: number; total: number };
  onDone: (done: boolean) => void | Promise<void>;
  /** Recording hooks (T15). */
  onRecord?: () => void;
  onCancelRecord?: () => void;
  onRerecord?: (id: string) => void;
  onDelete?: (id: string) => void;
  onRetry?: (id: string) => void;
  onDeadline?: () => void;
  canRecord?: boolean;
  recordHint?: string;
  /** Extra status line (uploads etc.). */
  status?: ReactNode;
  limitsLabel?: string;
}

/**
 * The dubbing editor: the clip (master clock), a DubPlayer that plays your takes under it,
 * transport, timeline and the deadline.
 */
export function Editor(props: EditorProps) {
  const { clip, editorKey } = props;
  const videoRef = useRef<HTMLVideoElement>(null);

  // Fresh state for this round (unless we're remounting the same round).
  if (editorStore.get().key !== editorKey) editorStore.set((s) => resetFor(s, editorKey, clip.durationMs));

  // ---- media wiring ----
  useEffect(() => {
    const video = videoRef.current!;
    const ctx = getAudioContext();
    const s0 = editorStore.get();
    video.playbackRate = s0.speed;
    video.defaultPlaybackRate = 1;
    video.volume = s0.refVolume;
    video.muted = !s0.refAudio;
    video.preservesPitch = true;

    const player = new DubPlayer({
      video,
      ctx,
      onEvent: import.meta.env.DEV
        ? (e) => {
            if (e.type === 'resync') console.debug('[dub] resync', e.driftMs.toFixed(1));
            dubLog.push({ t: performance.now(), ...e });
            if (dubLog.length > 500) dubLog.shift();
          }
        : undefined,
    });
    media.video = video;
    media.player = player;

    const syncChunks = (s = editorStore.get()) => {
      const skip = s.recording?.replacingId ?? null;
      const list: DubChunk[] = [];
      for (const c of s.chunks) {
        if (!c.buffer || c.meta.id === skip) continue;
        list.push({ id: c.meta.id, startMs: c.meta.startMs, offsetMs: c.meta.offsetMs, durationMs: c.meta.durationMs, buffer: c.buffer });
      }
      player.setChunks(list);
    };
    syncChunks();
    const unsub = useEditor.subscribe((s, prev) => {
      if (s.chunks !== prev.chunks || s.recording?.replacingId !== prev.recording?.replacingId) syncChunks(s);
    });

    const setCursor = () => {
      const ms = video.currentTime * 1000;
      editorStore.set((s) => (Math.abs(s.cursorMs - ms) < 1 ? s : { ...s, cursorMs: ms }));
    };
    const onPlay = () => editorStore.set((s) => (s.playing ? s : { ...s, playing: true }));
    const onPause = () => {
      editorStore.set((s) => (s.playing ? { ...s, playing: false } : s));
      setCursor();
    };
    const onSeeked = () => {
      flushPendingSeek();
      if (media.pendingSeekMs === null && media.scrubMs === null) setCursor();
    };
    const onRate = () => {
      // Keep the store honest if something else changed the rate.
      const r = video.playbackRate;
      const s = editorStore.get();
      if (!s.recording && r !== s.speed && (r === 0.5 || r === 1 || r === 1.5 || r === 2))
        editorStore.set((x) => ({ ...x, speed: r }));
    };
    const evs: [string, () => void][] = [
      ['play', onPlay],
      ['pause', onPause],
      ['ended', onPause],
      ['seeked', onSeeked],
      ['timeupdate', setCursor],
      ['ratechange', onRate],
    ];
    for (const [t, f] of evs) video.addEventListener(t, f);

    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__dubEditor = { editorStore, media, transport, dubLog };

    return () => {
      for (const [t, f] of evs) video.removeEventListener(t, f);
      unsub();
      video.pause();
      player.dispose();
      if (media.player === player) {
        media.player = null;
        media.video = null;
        media.pendingSeekMs = null;
        media.scrubMs = null;
      }
    };
  }, []);

  const del = useCallback(
    (id: string) => {
      if (props.onDelete) props.onDelete(id);
      else editorStore.set((s) => deleteChunk(s, id));
    },
    [props.onDelete],
  );

  useEditorKeys({
    onRecord: props.onRecord,
    onStopRecording: props.onRecord,
    onRerecord: props.onRerecord,
    onDelete: del,
    disabled: props.done,
  });

  return (
    <div className="flex flex-col gap-5" data-testid="editor">
      <EditorHeader {...props} />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Card className="overflow-hidden">
          <CardContent className="flex flex-col gap-4 p-3 sm:p-4">
            <VideoStage clip={clip} videoRef={videoRef} />
            <Transport
              onRecord={props.onRecord}
              onCancelRecord={props.onCancelRecord}
              canRecord={props.canRecord && !props.done}
              recordHint={props.recordHint}
            />
          </CardContent>
        </Card>

        <div className="flex flex-col gap-5">
          <Card>
            <CardContent className="p-5">
              <ReferenceAudio />
            </CardContent>
          </Card>
          <Card className="hidden lg:block">
            <CardContent className="p-5">
              <Shortcuts />
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-4 p-3 sm:p-5">
          <Timeline onRetry={props.onRetry} />
          <SelectionBar onRerecord={props.onRerecord} onDelete={del} status={props.status} limitsLabel={props.limitsLabel} />
        </CardContent>
      </Card>
    </div>
  );
}

/** DEV: DubPlayer events, for checking resync rates from Playwright (`__dubEditor.dubLog`). */
const dubLog: unknown[] = [];

function EditorHeader({ clip, roundLabel, phaseEndsAt, done, doneBusy, doneCount, onDone, onDeadline }: EditorProps) {
  const recording = useEditor((s) => s.recording !== null);
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <p className="flex items-center gap-2">
          <span className="tape">{roundLabel} · Dub this clip</span>
          {recording && (
            <span
              data-testid="on-air"
              className="inline-flex animate-fade-in items-center gap-1.5 rounded-md border-2 border-rose-400 px-2 py-px text-[11px] font-black uppercase tracking-[0.18em] text-rose-300 shadow-[0_0_16px_rgba(244,63,94,0.45)]"
            >
              <span className="size-1.5 animate-pulse rounded-full bg-rose-400" /> On air
            </span>
          )}
        </p>
        <h2 className="mt-2 truncate font-display text-3xl font-extrabold sm:text-4xl" data-testid="clip-title">
          {clip.title}
        </h2>
        <p className="mt-0.5 truncate text-xs text-zinc-400">
          {clip.attribution.author} · {clip.attribution.source} ·{' '}
          {clip.attribution.licenseUrl ? (
            <a href={clip.attribution.licenseUrl} target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-zinc-300 hover:underline">
              {clip.attribution.license}
            </a>
          ) : (
            clip.attribution.license
          )}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Countdown endsAt={phaseEndsAt} onExpire={onDeadline} />
        {done ? (
          <Button variant="outline" data-testid="done" aria-pressed onClick={() => onDone(false)}>
            <Undo2 /> Keep editing
          </Button>
        ) : (
          <Button variant="success" data-testid="done" disabled={recording || doneBusy} onClick={() => onDone(true)}>
            {doneBusy ? <Spinner className="size-4" /> : <Check strokeWidth={3} />}
            {doneBusy ? 'Saving…' : "I'm done"}
          </Button>
        )}
      </div>
      {done && (
        <div
          data-testid="done-banner"
          className="flex w-full animate-fade-up items-center gap-3 rounded-2xl border-[1.5px] border-emerald-400/30 bg-emerald-400/[0.08] px-4 py-3 text-sm text-emerald-100 shadow-[0_4px_0_rgb(0_0_0/0.4)]"
        >
          <Hourglass className="size-4 shrink-0 animate-pulse text-emerald-300" />
          <span>
            Submitted. Waiting for the others ({doneCount.done}/{doneCount.total} done). You can still
            listen back, or keep editing until the timer runs out.
          </span>
        </div>
      )}
    </div>
  );
}

function VideoStage({ clip, videoRef }: { clip: ClipInfo; videoRef: React.RefObject<HTMLVideoElement | null> }) {
  const playing = useEditor((s) => s.playing);
  const speed = useEditor((s) => s.speed);
  const recording = useEditor((s) => s.recording);
  const aspect = clip.width > 0 && clip.height > 0 ? clip.width / clip.height : 16 / 9;
  return (
    <div
      className={cn(
        'relative mx-auto w-full overflow-hidden rounded-2xl border-2 border-[#1a1027] bg-black transition-shadow duration-300',
        recording && recording.phase === 'recording' && 'shadow-[0_0_0_3px_rgba(244,63,94,0.85),0_0_40px_rgba(244,63,94,0.35)]',
      )}
      style={{ aspectRatio: aspect, maxHeight: 'min(46vh, 540px)', maxWidth: `calc(min(46vh, 540px) * ${aspect})` }}
    >
      <video
        ref={videoRef}
        data-testid="video"
        src={clip.url}
        poster={clip.posterUrl}
        playsInline
        preload="auto"
        disablePictureInPicture
        controlsList="nodownload noplaybackrate"
        onClick={() => !recording && transport.toggle()}
        className="size-full cursor-pointer object-contain"
      />
      {!playing && !recording && (
        <button
          type="button"
          aria-label="Play"
          onClick={() => transport.play()}
          className="group absolute inset-0 flex items-center justify-center bg-black/10 transition-colors hover:bg-black/25"
        >
          <span className="inline-flex size-16 animate-pop items-center justify-center rounded-full border-2 border-[#1a1027] bg-brand shadow-[0_4px_0_rgb(0_0_0/0.5)] transition-transform group-hover:scale-105">
            <Play className="size-7 translate-x-0.5 text-white" fill="currentColor" />
          </span>
        </button>
      )}
      <div className="pointer-events-none absolute left-3 top-3 flex gap-2">
        {recording && (
          <Badge className="animate-fade-in border-transparent bg-rose-600 px-3 py-1 text-sm text-white shadow-lg shadow-rose-600/40">
            <span className="mr-1 size-2 animate-pulse rounded-full bg-white" />
            {recording.phase === 'arming' ? 'Get ready…' : recording.replacingId ? 'Re-recording' : 'Recording'}
          </Badge>
        )}
        {!recording && speed !== 1 && (
          <Badge variant="secondary" className="animate-fade-in bg-black/60 backdrop-blur">
            <Gauge /> Preview {speed}×
          </Badge>
        )}
      </div>
    </div>
  );
}

function SelectionBar({
  onRerecord,
  onDelete,
  status,
  limitsLabel,
}: {
  onRerecord?: (id: string) => void;
  onDelete: (id: string) => void;
  status?: ReactNode;
  limitsLabel?: string;
}) {
  const sel = useEditor((s) => s.chunks.find((c) => c.meta.id === s.selectedId) ?? null);
  const recording = useEditor((s) => s.recording !== null);
  const count = useEditor((s) => s.chunks.length);
  return (
    <div className="flex min-h-11 flex-wrap items-center justify-between gap-3 px-1">
      {sel ? (
        <SelectedInfo chunk={sel} recording={recording} onRerecord={onRerecord} onDelete={onDelete} />
      ) : (
        <p className="flex items-center gap-2 text-sm text-zinc-500">
          <Mic className="size-4" />
          {count === 0
            ? 'Recording always runs at 1× from the cursor. The other takes keep playing, so you can layer.'
            : 'Click a take to select it. Double-click plays from its start.'}
        </p>
      )}
      <div className="flex items-center gap-3 text-xs text-zinc-500">
        {status}
        {limitsLabel && <span className="font-mono tabular-nums" data-testid="chunk-count">{limitsLabel}</span>}
      </div>
    </div>
  );
}

function SelectedInfo({
  chunk,
  recording,
  onRerecord,
  onDelete,
}: {
  chunk: EditorChunk;
  recording: boolean;
  onRerecord?: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { meta, take } = chunk;
  return (
    <div className="flex animate-fade-in flex-wrap items-center gap-2" data-testid="selection">
      <span className="mr-1 text-sm">
        <span className="font-semibold text-zinc-100">Take {take}</span>{' '}
        <span className="font-mono text-xs tabular-nums text-zinc-400">
          {formatPrecise(meta.startMs)} → {formatPrecise(meta.startMs + meta.durationMs)} · {formatSeconds(meta.durationMs)}
        </span>
      </span>
      <Button size="sm" variant="ghost" disabled={recording} onClick={() => transport.playFrom(meta.startMs)}>
        <CirclePlay /> Play
      </Button>
      <Button
        size="sm"
        variant="secondary"
        data-testid="rerecord"
        disabled={recording || !onRerecord || chunk.status === 'restoring'}
        onClick={() => onRerecord?.(meta.id)}
      >
        <RotateCcw /> Re-record
      </Button>
      <Button
        size="sm"
        variant="ghost"
        data-testid="delete"
        disabled={recording}
        onClick={() => onDelete(meta.id)}
        className="text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
      >
        <Trash2 /> Delete
      </Button>
    </div>
  );
}

function Shortcuts() {
  const rows: [string[], string][] = [
    [['Space'], 'Play / pause'],
    [['R'], 'Record / stop'],
    [['←', '→'], '±5 s'],
    [['⇧', '←'], '±0.1 s'],
    [['1', '4'], 'Speed'],
    [['M'], 'Original audio'],
    [['Del'], 'Delete take'],
    [['⇧', 'R'], 'Re-record take'],
    [['Esc'], 'Deselect / stop'],
  ];
  return (
    <div className="flex flex-col gap-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-zinc-300">
        <Keyboard className="size-4 text-fuchsia-300" /> Shortcuts
      </p>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-xs">
        {rows.map(([keys, label]) => (
          <div key={label} className="contents">
            <dt className="flex items-center gap-1">
              {keys.map((k, i) => (
                <span key={k} className="flex items-center gap-1">
                  {i > 0 && <span className="text-zinc-600">{keys[0] === '1' ? '–' : keys[0] === '←' ? '/' : '+'}</span>}
                  <Kbd>{k}</Kbd>
                </span>
              ))}
            </dt>
            <dd className="text-zinc-400">{label}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
