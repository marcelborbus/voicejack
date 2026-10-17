import type { ClipInfo, ShowcaseItem } from '@dub/shared';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { getAudioContext } from '@/audio/context';
import { loadChunks } from '@/dub/chunkLoader';
import { DubPlayer, type DubChunk } from '@/dub/DubPlayer';
import { useRoom } from '@/state/room';
import { send, serverToPerf } from '@/state/session';
import { getToken } from '@/state/storage';

export type LoadState = 'loading' | 'ready' | 'failed';

/** Resolves once the video can play through (or right away if it already can). */
export function waitCanPlayThrough(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  if (video.readyState >= 4) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error('video failed to load'));
    };
    const abort = () => {
      cleanup();
      reject(new DOMException('aborted', 'AbortError'));
    };
    const cleanup = () => {
      video.removeEventListener('canplaythrough', done);
      video.removeEventListener('error', fail);
      signal.removeEventListener('abort', abort);
    };
    video.addEventListener('canplaythrough', done);
    video.addEventListener('error', fail);
    signal.addEventListener('abort', abort);
    // Some browsers stop buffering a paused, muted, preload=auto video early; nudge it.
    if (video.networkState === HTMLMediaElement.NETWORK_IDLE && video.readyState < 3) video.load();
  });
}

/**
 * Drives the showcase `<video>`: per item, preloads the clip and decodes the dub's chunks,
 * reports `preloaded`, then plays in sync with the server's `startAt` (§2.3 synced mode).
 * The video stays muted; only the dub is audible.
 */
export function useShowcasePlayback(
  videoRef: RefObject<HTMLVideoElement | null>,
  clip: ClipInfo | null,
  item: ShowcaseItem | null,
): { load: LoadState; chunkCount: number } {
  const code = useRoom((s) => s.code);
  const connStatus = useRoom((s) => s.status);
  const playerRef = useRef<DubPlayer | null>(null);
  const [loaded, setLoaded] = useState<{ subId: string; state: LoadState; count: number } | null>(
    null,
  );
  const subId = item?.submissionId ?? null;
  const status = item?.status ?? null;
  const startAt = item?.startAt ?? null;

  // One engine per video element.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const player = new DubPlayer({ video, ctx: getAudioContext() });
    playerRef.current = player;
    if (import.meta.env.DEV) (window as unknown as { __showcasePlayer?: DubPlayer }).__showcasePlayer = player;
    return () => {
      player.dispose();
      playerRef.current = null;
    };
  }, [videoRef, clip?.url]);

  // Load the current item's audio + make sure the video is buffered.
  useEffect(() => {
    const video = videoRef.current;
    const player = playerRef.current;
    if (!video || !player || !item || !subId) return;
    const ac = new AbortController();
    player.setChunks([]);
    setLoaded({ subId, state: 'loading', count: 0 });
    const token = code ? getToken(code) : null;
    const ctx = getAudioContext();
    Promise.all([
      // No abort signal here: decoded chunks are cached by URL and shared, so an aborted
      // fetch would poison the cache for the next mount (StrictMode, quick remounts).
      loadChunks(ctx, item.chunks, { token }),
      waitCanPlayThrough(video, ac.signal),
    ]).then(
      ([chunks]) => {
        if (ac.signal.aborted) return;
        const dub: DubChunk[] = chunks.map((c) => ({
          id: c.meta.id,
          startMs: c.meta.startMs,
          offsetMs: c.meta.offsetMs,
          durationMs: c.meta.durationMs,
          buffer: c.buffer,
        }));
        player.setChunks(dub);
        setLoaded({ subId, state: 'ready', count: dub.length });
      },
      (e: unknown) => {
        if (ac.signal.aborted) return;
        console.warn('[showcase] preload failed', e);
        setLoaded({ subId, state: 'failed', count: 0 });
      },
    );
    return () => ac.abort();
    // `item.chunks` is fixed per submission; keyed on the id on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subId, clip?.url]);

  const load: LoadState = loaded && loaded.subId === subId ? loaded.state : 'loading';

  // Tell the server we're ready (again after a reconnect, harmless if it already knows).
  useEffect(() => {
    if (!subId || status !== 'LOADING' || connStatus !== 'open') return;
    if (load === 'ready' || load === 'failed') send({ t: 'preloaded', submissionId: subId });
  }, [subId, status, load, connStatus]);

  // Follow the server timeline.
  useEffect(() => {
    const player = playerRef.current;
    const video = videoRef.current;
    if (!player || !video || !clip) return;
    if (status === 'PLAYING' && startAt !== null) {
      player.syncTo(serverToPerf(startAt), clip.durationMs);
    } else {
      player.syncTo(null);
      if (status === 'LOADING' && video.currentTime !== 0) video.currentTime = 0;
    }
  }, [status, startAt, subId, clip, videoRef]);

  return { load, chunkCount: loaded?.subId === subId ? loaded.count : 0 };
}
