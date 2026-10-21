import type { ChunkRef, ClipInfo } from '@dub/shared';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getAudioContext, unlockAudio } from '@/audio/context';
import { DubPlayer, type DubChunk } from '@/dub/DubPlayer';
import { loadDub } from '@/dub/fx';
import { premixDub } from '@/dub/premix';
import { clipSource } from '@/lib/lite';
import { Button } from '@/components/ui/button';
import { FxBadge } from '@/components/showcase/FxBadge';
import { Spinner } from '@/components/ui/spinner';
import { useRoom } from '@/state/room';
import { getToken } from '@/state/storage';

/**
 * Decodes a submission's chunks (cached by URL), renders their effects (#48) and mixes them into
 * one buffer (#53: one source node for the replay and the Save-video render).
 */
export function useDubChunks(chunks: readonly ChunkRef[]): DubChunk[] | null {
  const code = useRoom((s) => s.code);
  const [out, setOut] = useState<DubChunk[] | null>(null);
  const key = chunks.map((c) => `${c.url}#${c.fx ?? ''}`).join('|');
  useEffect(() => {
    let alive = true;
    setOut(null);
    const token = code ? getToken(code) : null;
    const ctx = getAudioContext();
    loadDub(ctx, chunks, { token })
      .then((dub) => premixDub(dub, { sampleRate: ctx.sampleRate }).catch(() => dub))
      .then((dub) => {
        if (alive) setOut(dub);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, code]);
  return out;
}

/** Local replay of the winning dub: muted clip + DubPlayer following the video. */
export function BestDubReplay({
  clip,
  dub,
  chunks,
  pauseSignal,
}: {
  clip: ClipInfo;
  dub: DubChunk[] | null;
  /** #48: the dub's chunks, for the effects badge. */
  chunks?: readonly ChunkRef[];
  /** Bumping this pauses the replay (e.g. when a render starts). */
  pauseSignal?: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<DubPlayer | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const player = new DubPlayer({ video, ctx: getAudioContext() });
    playerRef.current = player;
    const onPlay = () => setPlaying(true);
    const onStop = () => setPlaying(false);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onStop);
    video.addEventListener('ended', onStop);
    let raf = 0;
    const tick = () => {
      if (barRef.current)
        barRef.current.style.transform = `scaleX(${Math.min(1, video.currentTime / (clip.durationMs / 1000))})`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onStop);
      video.removeEventListener('ended', onStop);
      player.dispose();
      playerRef.current = null;
    };
  }, [clip.url, clip.durationMs]);

  useEffect(() => {
    if (dub) playerRef.current?.setChunks(dub);
  }, [dub]);

  useEffect(() => {
    if (pauseSignal) videoRef.current?.pause();
  }, [pauseSignal]);

  function toggle() {
    const v = videoRef.current;
    if (!v) return;
    void unlockAudio();
    if (v.paused) {
      if (v.ended || v.currentTime >= clip.durationMs / 1000 - 0.05) v.currentTime = 0;
      void v.play();
    } else v.pause();
  }

  return (
    <div className="flex flex-col gap-3" data-testid="replay">
      <div
        className="group relative overflow-hidden rounded-[1.25rem] bg-black ring-1 ring-white/10"
        style={{ aspectRatio: `${clip.width} / ${clip.height}` }}
      >
        <video
          ref={videoRef}
          src={clipSource(clip)}
          poster={clip.posterUrl}
          muted
          playsInline
          preload="auto"
          disablePictureInPicture
          className="absolute inset-0 size-full object-contain"
          onClick={toggle}
        />
        {chunks && <FxBadge chunks={chunks} />}
        {!playing && (
          <button
            type="button"
            onClick={toggle}
            disabled={!dub}
            aria-label="Play the winning dub"
            className="absolute inset-0 flex items-center justify-center bg-black/35 transition-colors hover:bg-black/20"
          >
            <span className="inline-flex size-20 items-center justify-center rounded-full bg-brand shadow-2xl shadow-fuchsia-500/40 transition-transform group-hover:scale-105">
              {dub ? (
                <Play className="ml-1 size-9 fill-white text-white" />
              ) : (
                <Spinner className="size-8 text-white" />
              )}
            </span>
          </button>
        )}
      </div>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="secondary"
          onClick={toggle}
          disabled={!dub}
          data-testid="replay-play"
        >
          {playing ? <Pause /> : <Play />} {playing ? 'Pause' : 'Play'}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Restart"
          onClick={() => {
            const v = videoRef.current;
            if (v) v.currentTime = 0;
          }}
        >
          <RotateCcw />
        </Button>
        <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
          <div
            ref={barRef}
            className="absolute inset-0 origin-left bg-brand"
            style={{ transform: 'scaleX(0)' }}
          />
        </div>
      </div>
    </div>
  );
}
