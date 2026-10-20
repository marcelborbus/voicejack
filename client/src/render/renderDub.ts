import type { ClipInfo } from '@dub/shared';
import { DubPlayer, type DubChunk } from '@/dub/DubPlayer';

/** Preferred output formats, best first (§2.3): webm vp9/vp8 + opus, mp4 for Safari. */
export const RENDER_MIMES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
] as const;

/** First supported render mime, or null when this browser can't record video at all. */
export function pickRenderMime(
  isTypeSupported: (mime: string) => boolean = (m) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m),
): string | null {
  for (const m of RENDER_MIMES) {
    try {
      if (isTypeSupported(m)) return m;
    } catch {
      /* some browsers throw for unknown strings */
    }
  }
  return null;
}

export function renderExtension(mime: string): 'webm' | 'mp4' {
  return mime.startsWith('video/mp4') ? 'mp4' : 'webm';
}

function slug(s: string): string {
  const out = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return out || 'dub';
}

/** `voicejack-<clip>-<name>.webm` with both parts made filename-safe. */
export function renderFileName(clipId: string, playerName: string, mime: string): string {
  return `voicejack-${slug(clipId)}-${slug(playerName)}.${renderExtension(mime)}`;
}

/** Output canvas size: the clip's own size, at most 1280 px wide/720 px high, even numbers. */
export function renderSize(width: number, height: number): { width: number; height: number } {
  const w0 = width > 0 ? width : 1280;
  const h0 = height > 0 ? height : 720;
  const k = Math.min(1, 1280 / w0, 720 / h0);
  const even = (n: number) => Math.max(2, Math.round((n * k) / 2) * 2);
  return { width: even(w0), height: even(h0) };
}

/** How long to keep recording after the clip ends: 250 ms, or until the last effect tail ends (≤ 2 s). */
export function renderTailMs(chunks: readonly DubChunk[], clipMs: number): number {
  let end = 0;
  for (const c of chunks) end = Math.max(end, c.startMs + c.durationMs + (c.tailMs ?? 0) - clipMs);
  return Math.round(Math.max(250, Math.min(2000, end + 100)));
}

export interface RenderOptions {
  clip: ClipInfo;
  chunks: readonly DubChunk[];
  ctx: AudioContext;
  /** Small credit line drawn on the video (CC BY attribution). */
  credit?: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface RenderResult {
  blob: Blob;
  mime: string;
  ext: 'webm' | 'mp4';
}

function waitForVideo(video: HTMLVideoElement, signal?: AbortSignal): Promise<void> {
  if (video.readyState >= 4) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const off = () => {
      video.removeEventListener('canplaythrough', ok);
      video.removeEventListener('error', bad);
      signal?.removeEventListener('abort', abort);
    };
    const ok = () => (off(), resolve());
    const bad = () => (off(), reject(new Error('The clip could not be loaded.')));
    const abort = () => (off(), reject(new DOMException('Render cancelled', 'AbortError')));
    video.addEventListener('canplaythrough', ok);
    video.addEventListener('error', bad);
    signal?.addEventListener('abort', abort);
  });
}

function drawFrame(
  g: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  w: number,
  h: number,
  credit: string | undefined,
): void {
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
  if (video.readyState >= 2) g.drawImage(video, 0, 0, w, h);
  const pad = Math.round(h * 0.03);
  const fs = Math.max(10, Math.round(h * 0.028));
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.75)';
  g.shadowBlur = 4;
  g.textBaseline = 'bottom';
  if (credit) {
    g.font = `500 ${fs}px Inter, system-ui, sans-serif`;
    g.fillStyle = 'rgba(255,255,255,0.78)';
    g.textAlign = 'left';
    g.fillText(credit, pad, h - pad, w - pad * 2 - fs * 9);
  }
  g.font = `800 ${Math.round(fs * 1.15)}px "Bricolage Grotesque Variable", Inter, system-ui, sans-serif`;
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.textAlign = 'right';
  g.fillText('Voicejack', w - pad, h - pad);
  g.restore();
}

/**
 * Renders clip + dub to a video file in real time (§2.3): a hidden same-origin `<video>` is
 * painted onto a canvas every frame, `canvas.captureStream()` gives the picture, a DubPlayer
 * plays the dub into a MediaStreamAudioDestinationNode, and MediaRecorder muxes both.
 * Nothing is audible while rendering.
 */
export async function renderDub(opts: RenderOptions): Promise<RenderResult> {
  const { clip, ctx, signal } = opts;
  const mime = pickRenderMime();
  if (!mime) throw new Error("This browser can't record video. Try Chrome or Firefox.");
  if (signal?.aborted) throw new DOMException('Render cancelled', 'AbortError');
  if (ctx.state !== 'running') await ctx.resume().catch(() => undefined);

  const { width, height } = renderSize(clip.width, clip.height);
  const durationS = clip.durationMs / 1000;

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = clip.url;
  // Kept in the DOM (some browsers don't paint frames of detached videos) but invisible.
  Object.assign(video.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '2px',
    height: '2px',
    opacity: '0',
    pointerEvents: 'none',
  });
  document.body.appendChild(video);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d', { alpha: false });
  if (!g) throw new Error('Canvas is not available.');

  let player: DubPlayer | null = null;
  let stream: MediaStream | null = null;
  let rafId = 0;
  let stopped = false;
  let stopKeepAlive = () => {};
  const cleanup = () => {
    stopped = true;
    stopKeepAlive();
    cancelAnimationFrame(rafId);
    player?.dispose();
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
    stream?.getTracks().forEach((t) => t.stop());
  };

  try {
    await waitForVideo(video, signal);
    if (video.currentTime !== 0) video.currentTime = 0;

    const dest = ctx.createMediaStreamDestination();
    // Keep the audio track "live" through silent stretches: with nothing playing, Chrome
    // stops emitting audio packets and the file's audio track ends early.
    const keepAlive = ctx.createConstantSource();
    keepAlive.offset.value = 0;
    keepAlive.connect(dest);
    keepAlive.start();
    stopKeepAlive = () => {
      try {
        keepAlive.stop();
      } catch {
        /* not started */
      }
      keepAlive.disconnect();
    };
    player = new DubPlayer({ video, ctx, output: dest, compensateLatency: false });
    player.setChunks(opts.chunks);

    const vTrack = canvas.captureStream(30).getVideoTracks()[0];
    const aTrack = dest.stream.getAudioTracks()[0];
    stream = new MediaStream([vTrack, aTrack].filter((t): t is MediaStreamTrack => !!t));

    // Paint loop: every decoded frame (rVFC) plus rAF as a fallback.
    const paint = () => {
      if (stopped) return;
      drawFrame(g, video, width, height, opts.credit);
      opts.onProgress?.(Math.min(1, video.currentTime / durationS));
    };
    const rvfc = (
      video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      }
    ).requestVideoFrameCallback?.bind(video);
    if (rvfc) {
      const onFrame = () => {
        paint();
        if (!stopped) rvfc(onFrame);
      };
      rvfc(onFrame);
    }
    // rAF also paints whenever the video moved, in case frame callbacks are throttled.
    let lastPainted = -1;
    const loop = () => {
      if (!rvfc || video.paused || video.currentTime !== lastPainted) {
        lastPainted = video.currentTime;
        paint();
      }
      rafId = requestAnimationFrame(loop);
    };
    loop();
    paint();

    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 4_000_000,
      audioBitsPerSecond: 128_000,
    });
    const parts: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size > 0 && parts.push(e.data);
    const finished = new Promise<void>((resolve, reject) => {
      recorder.onstop = () => resolve();
      recorder.onerror = (e) =>
        reject((e as unknown as { error?: Error }).error ?? new Error('Recording failed'));
    });
    finished.catch(() => undefined); // awaited below; avoid an unhandled rejection on abort

    await new Promise<void>((resolve, reject) => {
      let lastT = -1;
      let lastMove = performance.now();
      const watchdog = setInterval(() => {
        if (video.currentTime !== lastT) {
          lastT = video.currentTime;
          lastMove = performance.now();
        } else if (performance.now() - lastMove > 10_000) {
          done(new Error('Rendering stalled. Keep this tab in front and try again.'));
        }
        if (video.ended || video.currentTime >= durationS - 0.02) done();
      }, 100);
      const onAbort = () => done(new DOMException('Render cancelled', 'AbortError'));
      const done = (err?: Error) => {
        clearInterval(watchdog);
        signal?.removeEventListener('abort', onAbort);
        video.removeEventListener('ended', onEnded);
        if (err) reject(err);
        else resolve();
      };
      const onEnded = () => done();
      video.addEventListener('ended', onEnded);
      signal?.addEventListener('abort', onAbort);
      recorder.onstart = () => {
        video.play().catch((e: unknown) => done(e instanceof Error ? e : new Error(String(e))));
      };
      recorder.start(500);
    }).catch(async (e: unknown) => {
      if (recorder.state !== 'inactive') recorder.stop();
      throw e;
    });

    // Let the last frame and the audio tail reach the recorder (#48: and effect tails of takes
    // near the clip end ring out over the last frame, up to 2 s).
    paint();
    await new Promise((r) => setTimeout(r, renderTailMs(opts.chunks, clip.durationMs)));
    if (recorder.state !== 'inactive') recorder.stop();
    await finished;
    opts.onProgress?.(1);
    const type = mime.split(';')[0]!;
    return { blob: new Blob(parts, { type }), mime, ext: renderExtension(mime) };
  } finally {
    cleanup();
  }
}

/** Starts a browser download of `blob`. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
