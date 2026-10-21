import type { ClipInfo } from '@dub/shared';

/**
 * #53 "lite mode": when the showcase video drops frames (>10 % over 3 s) the rest of the session
 * runs without decorative animations and backdrop effects (`:root[data-lite]` in index.css), the
 * speaking strip updates at 4 Hz, and clips play from their 480p rendition (`ClipInfo.lowUrl`).
 * Low-end devices (≤ 4 cores or ≤ 4 GB) get the 480p clips from the start.
 */

const KEY = 'vj.lite';
let lite = false;
const listeners = new Set<(on: boolean) => void>();

function readStored(): boolean {
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

if (typeof window !== 'undefined' && readStored()) apply(true);

function apply(on: boolean): void {
  lite = on;
  if (typeof document !== 'undefined') {
    if (on) document.documentElement.dataset.lite = '1';
    else delete document.documentElement.dataset.lite;
  }
  for (const fn of [...listeners]) fn(on);
}

export function isLite(): boolean {
  return lite;
}

/** Turns lite mode on for the rest of the session. */
export function enableLite(reason: string): void {
  if (lite) return;
  console.info(`[lite] on: ${reason}`);
  try {
    sessionStorage.setItem(KEY, '1');
  } catch {
    /* private mode */
  }
  apply(true);
}

/** Test hook. */
export function resetLite(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  apply(false);
}

export function onLiteChange(fn: (on: boolean) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function isLowEndDevice(
  nav: { hardwareConcurrency?: number; deviceMemory?: number } = typeof navigator !== 'undefined'
    ? (navigator as { hardwareConcurrency?: number; deviceMemory?: number })
    : {},
): boolean {
  const cores = nav.hardwareConcurrency;
  const mem = nav.deviceMemory;
  return (cores !== undefined && cores > 0 && cores <= 4) || (mem !== undefined && mem <= 4);
}

/** The clip URL to play in the showcase / final replay (480p in lite mode or on weak devices). */
export function clipSource(clip: Pick<ClipInfo, 'url' | 'lowUrl'>): string {
  return clip.lowUrl && (lite || isLowEndDevice()) ? clip.lowUrl : clip.url;
}

export interface QualitySample {
  t: number;
  dropped: number;
  total: number;
}

/**
 * Frame-drop watcher: feed it `getVideoPlaybackQuality()` samples (or rVFC-derived counts) while a
 * video plays. True once more than `maxDropRatio` of the frames of the last `windowMs` dropped.
 */
export class DropWatch {
  private samples: QualitySample[] = [];
  constructor(
    private readonly windowMs = 3000,
    private readonly maxDropRatio = 0.1,
    private readonly minFrames = 30,
  ) {}

  push(s: QualitySample): boolean {
    this.samples.push(s);
    while (this.samples.length > 1 && s.t - this.samples[0]!.t > this.windowMs)
      this.samples.shift();
    const first = this.samples[0]!;
    const frames = s.total - first.total;
    const dropped = s.dropped - first.dropped;
    return (
      s.t - first.t >= this.windowMs * 0.9 &&
      frames >= this.minFrames &&
      dropped / frames > this.maxDropRatio
    );
  }

  reset(): void {
    this.samples = [];
  }
}
