import type { ClipInfo, ShowcaseItem } from '@dub/shared';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { getAudioContext } from '@/audio/context';
import { acquireClip, prefetchClip } from '@/dub/clipCache';
import { loadDub } from '@/dub/fx';
import { premixDub } from '@/dub/premix';
import { SyncedDubPlayer, type SyncStats } from '@/dub/SyncedDubPlayer';
import { clipSource, DropWatch, enableLite, isLite } from '@/lib/lite';
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

/** True once `video.buffered` covers the whole clip (a blob source always does once loaded). */
export function fullyBuffered(video: HTMLVideoElement, durationMs: number): boolean {
  const b = video.buffered;
  const need = Math.min(
    durationMs / 1000,
    Number.isFinite(video.duration) ? video.duration : Infinity,
  );
  for (let i = 0; i < b.length; i++) if (b.start(i) <= 0.05 && b.end(i) >= need - 0.25) return true;
  return false;
}

type QualityVideo = HTMLVideoElement & {
  getVideoPlaybackQuality?: () => { droppedVideoFrames: number; totalVideoFrames: number };
};

/**
 * Samples the video's dropped/total frames (`getVideoPlaybackQuality`, else frame gaps from
 * `requestVideoFrameCallback`) and calls `onBad` once more than 10 % dropped over 3 s.
 */
export function watchDrops(video: QualityVideo, onBad: () => void): () => void {
  const watch = new DropWatch();
  let stop = false;
  if (typeof video.getVideoPlaybackQuality === 'function') {
    const t = setInterval(() => {
      const q = video.getVideoPlaybackQuality!();
      const bad = watch.push({
        t: performance.now(),
        dropped: q.droppedVideoFrames,
        total: q.totalVideoFrames,
      });
      if (bad && !stop) {
        stop = true;
        onBad();
      }
    }, 500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }
  if (typeof video.requestVideoFrameCallback !== 'function') return () => undefined;
  // Fallback: a gap of more than 1.5 frame intervals counts the missing frames as dropped.
  let last: number | null = null;
  let frame = 1000 / 30;
  let total = 0;
  let dropped = 0;
  let handle = 0;
  const onFrame = (now: number) => {
    if (stop) return;
    if (last !== null) {
      const gap = now - last;
      if (gap < frame * 1.5) frame = frame * 0.9 + gap * 0.1;
      const missed = Math.max(0, Math.round(gap / frame) - 1);
      total += 1 + missed;
      dropped += missed;
      if (watch.push({ t: now, dropped, total })) {
        stop = true;
        onBad();
        return;
      }
    }
    last = now;
    handle = video.requestVideoFrameCallback(onFrame);
  };
  handle = video.requestVideoFrameCallback(onFrame);
  return () => {
    stop = true;
    video.cancelVideoFrameCallback?.(handle);
  };
}

/** Debug/e2e hook: the live sync stats of the showcase player (`window.__vjShowcase`). */
declare global {
  interface Window {
    __vjShowcase?: SyncStats & { item: string | null; src: string | null };
  }
}

/**
 * Drives the showcase `<video>` (§2.3 synced mode, #53):
 * - per item the clip is fetched completely into memory (`acquireClip`) and played from an object
 *   URL, the next item's clip is fetched ahead (`nextClip`),
 * - the dub's chunks are decoded, effect-rendered and pre-mixed into one buffer,
 * - only then `preloaded` goes to the server; playback follows the server's `startAt` with the
 *   audio as the reference and the video nudged after it (`SyncedDubPlayer`).
 * The video stays muted; only the dub is audible. Everything here is imperative (refs), so
 * PLAYING causes no React work.
 */
export function useShowcasePlayback(
  videoRef: RefObject<HTMLVideoElement | null>,
  clip: ClipInfo | null,
  item: ShowcaseItem | null,
): { load: LoadState; chunkCount: number } {
  const code = useRoom((s) => s.code);
  const connStatus = useRoom((s) => s.status);
  const playerRef = useRef<SyncedDubPlayer | null>(null);
  const [loaded, setLoaded] = useState<{ subId: string; state: LoadState; count: number } | null>(
    null,
  );
  const subId = item?.submissionId ?? null;
  const status = item?.status ?? null;
  const startAt = item?.startAt ?? null;
  // Picked once per item: lite mode switching on mid-item takes effect from the next one.
  const clipUrl = useMemo(
    () => (clip ? clipSource(clip) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subId, clip?.url, clip?.lowUrl],
  );
  const clipMs = clip?.durationMs ?? null;
  const nextUrl = item?.nextClip ? clipSource(item.nextClip) : null;

  // One engine per video element.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const player = new SyncedDubPlayer({ video, ctx: getAudioContext() });
    playerRef.current = player;
    window.__vjShowcase = Object.assign(player.stats, { item: null, src: null });
    return () => {
      player.dispose();
      playerRef.current = null;
    };
  }, [videoRef]);

  // The next item's clip, into memory while this one plays.
  useEffect(() => {
    if (nextUrl) prefetchClip(nextUrl);
  }, [nextUrl]);

  // Load the current item: clip into memory + fully buffered, dub decoded and pre-mixed.
  useEffect(() => {
    const video = videoRef.current;
    const player = playerRef.current;
    if (!video || !player || !item || !subId || !clipUrl || !clip) return;
    const ac = new AbortController();
    player.setChunks([]);
    setLoaded({ subId, state: 'loading', count: 0 });
    const token = code ? getToken(code) : null;
    const ctx = getAudioContext();
    const held = acquireClip(clipUrl);
    const videoReady = held.src.then(async (src) => {
      if (ac.signal.aborted) return;
      if (video.getAttribute('src') !== src) {
        video.src = src;
        video.load();
      }
      if (window.__vjShowcase) window.__vjShowcase.src = src;
      await waitCanPlayThrough(video, ac.signal);
      // A streamed fallback (blob fetch failed): wait (bounded) until all of it is buffered.
      for (let i = 0; i < 40 && !fullyBuffered(video, clip.durationMs); i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (ac.signal.aborted) return;
      }
    });
    Promise.all([
      // No abort signal here: decoded chunks are cached by URL and shared, so an aborted
      // fetch would poison the cache for the next mount (StrictMode, quick remounts).
      // #48: effects are rendered here too; #53: then mixed into one buffer.
      loadDub(ctx, item.chunks, { token }).then((dub) =>
        premixDub(dub, { sampleRate: ctx.sampleRate })
          .catch((e: unknown) => {
            console.warn('[showcase] pre-mix failed, playing the chunks', e);
            return dub;
          })
          .then((mix) => ({ mix, count: dub.length })),
      ),
      videoReady,
    ]).then(
      ([{ mix, count }]) => {
        if (ac.signal.aborted) return;
        player.setChunks(mix);
        if (window.__vjShowcase) window.__vjShowcase.item = subId;
        setLoaded({ subId, state: 'ready', count });
      },
      (e: unknown) => {
        if (ac.signal.aborted) return;
        console.warn('[showcase] preload failed', e);
        setLoaded({ subId, state: 'failed', count: 0 });
      },
    );
    return () => {
      ac.abort();
      // Unpin after the next item took over the element (its src replaced this one).
      setTimeout(held.release, 1000);
    };
    // `item.chunks` is fixed per submission; keyed on the id on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subId, clipUrl]);

  const load: LoadState = loaded && loaded.subId === subId ? loaded.state : 'loading';

  // Tell the server we're ready (again after a reconnect, harmless if it already knows).
  useEffect(() => {
    if (!subId || status !== 'LOADING' || connStatus !== 'open') return;
    if (load === 'ready' || load === 'failed') send({ t: 'preloaded', submissionId: subId });
  }, [subId, status, load, connStatus]);

  // #53: frame drops while playing → lite mode for the rest of the session.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || status !== 'PLAYING' || isLite()) return;
    return watchDrops(video, () => enableLite('showcase video dropped >10 % of frames'));
  }, [status, subId, videoRef]);

  // Follow the server timeline.
  useEffect(() => {
    const player = playerRef.current;
    const video = videoRef.current;
    if (!player || !video || clipMs === null) return;
    if (status === 'PLAYING' && startAt !== null) {
      player.syncTo(serverToPerf(startAt), clipMs);
    } else {
      player.syncTo(null);
      if (status === 'LOADING' && video.currentTime !== 0) video.currentTime = 0;
    }
  }, [status, startAt, subId, clipMs, videoRef]);

  return { load, chunkCount: loaded?.subId === subId ? loaded.count : 0 };
}
