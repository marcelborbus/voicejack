import type { ClipInfo } from '@dub/shared';
import { Check, Download, Film, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getAudioContext, unlockAudio } from '@/audio/context';
import type { DubChunk } from '@/dub/DubPlayer';
import { attributionText, ClipAttribution } from '@/components/showcase/ClipAttribution';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import './results.css';
import { toast } from '@/lib/toast';
import { downloadBlob, pickRenderMime, renderDub, renderFileName } from '@/render/renderDub';

type State =
  | { kind: 'idle' }
  | { kind: 'rendering'; progress: number }
  | { kind: 'done'; blob: Blob; filename: string };

/** "Save video": renders clip + dub in real time and downloads it (§2.3). */
export function SaveVideo({
  clip,
  dub,
  authorName,
  onStart,
}: {
  clip: ClipInfo;
  dub: DubChunk[] | null;
  authorName: string;
  onStart?: () => void;
}) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);
  const supported = pickRenderMime() !== null;

  useEffect(
    () => () => {
      abortRef.current?.abort();
      delete document.documentElement.dataset.rendering;
    },
    [],
  );

  async function save() {
    if (!dub) return;
    void unlockAudio();
    onStart?.();
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ kind: 'rendering', progress: 0 });
    document.documentElement.dataset.rendering = '1'; // see results.css
    try {
      const res = await renderDub({
        clip,
        chunks: dub,
        ctx: getAudioContext(),
        credit: attributionText(clip),
        signal: ac.signal,
        onProgress: (f) =>
          setState((s) => (s.kind === 'rendering' ? { kind: 'rendering', progress: f } : s)),
      });
      const filename = renderFileName(clip.id, authorName, res.mime);
      downloadBlob(res.blob, filename);
      setState({ kind: 'done', blob: res.blob, filename });
    } catch (e) {
      setState({ kind: 'idle' });
      if ((e as { name?: string }).name === 'AbortError') return;
      toast('Could not save the video', {
        variant: 'error',
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      delete document.documentElement.dataset.rendering;
      if (abortRef.current === ac) abortRef.current = null;
    }
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-3xl border border-white/[0.07] bg-white/[0.025] p-4"
      data-testid="save-video-panel"
      data-state={state.kind}
    >
      {state.kind === 'rendering' ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="flex items-center gap-2 font-semibold">
              <Film className="size-4 text-fuchsia-300" /> Rendering your video…
            </p>
            <span className="font-mono text-sm tabular-nums text-zinc-300" data-testid="save-progress">
              {Math.round(state.progress * 100)}%
            </span>
          </div>
          <Progress value={state.progress * 100} />
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-zinc-500">
              It plays through once in real time. Keep this tab in front.
            </p>
            <Button size="sm" variant="ghost" onClick={() => abortRef.current?.abort()}>
              <X /> Cancel
            </Button>
          </div>
        </>
      ) : state.kind === 'done' ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex min-w-0 items-center gap-2 text-sm text-emerald-300">
            <Check className="size-4 shrink-0" strokeWidth={3} />
            <span className="truncate">Saved as {state.filename}</span>
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => downloadBlob(state.blob, state.filename)}>
              <Download /> Download again
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setState({ kind: 'idle' })}>
              Render again
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold">Keep this one forever</p>
            <p className="text-xs text-zinc-500">
              {supported
                ? 'Downloads the clip with this dub as a video file.'
                : "This browser can't record video. Try Chrome or Firefox."}
            </p>
          </div>
          <Button data-testid="save-video" onClick={save} disabled={!dub || !supported}>
            <Download /> Save video
          </Button>
        </div>
      )}
      <ClipAttribution clip={clip} />
      <p className="-mt-1 pl-[22px] text-[11px] text-zinc-500">
        The credit line is burnt into the video. Please keep it when you share.
      </p>
    </div>
  );
}
