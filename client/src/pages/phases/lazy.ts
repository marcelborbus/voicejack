import { lazy, type ComponentType } from 'react';
import type { Phase } from '@dub/shared';

/**
 * #53: every phase but the lobby is its own chunk (editor + fx engine, showcase player, results,
 * final + video render). While a phase runs, the next one is fetched in the background
 * (`prefetchAfter`), so a phase change never waits on the network.
 */
type LazyPhase = Exclude<Phase, 'LOBBY'>;
type Loaded = { default: ComponentType };

const loaders: Record<LazyPhase, () => Promise<Loaded>> = {
  DUBBING: () =>
    import('./Dubbing').then((m) => {
      // The fx worklet is fetched by `addModule` later; warm the cache now.
      void import('@/dub/fx').then((fx) => fx.prefetchWorklet());
      return { default: m.Dubbing };
    }),
  SHOWCASE: () => import('./Showcase').then((m) => ({ default: m.Showcase })),
  ROUND_RESULTS: () => import('./RoundResults').then((m) => ({ default: m.RoundResults })),
  FINAL: () => import('./Final').then((m) => ({ default: m.Final })),
};

const started = new Map<LazyPhase, Promise<Loaded>>();

/** Starts (once) fetching a phase chunk. */
export function preloadPhase(phase: LazyPhase): Promise<Loaded> {
  let p = started.get(phase);
  if (!p) {
    p = loaders[phase]().catch((e: unknown) => {
      started.delete(phase); // retry on the next call (a network blip)
      throw e;
    });
    started.set(phase, p);
  }
  return p;
}

export const LazyPhases: Record<LazyPhase, ComponentType> = {
  DUBBING: lazy(() => preloadPhase('DUBBING')),
  SHOWCASE: lazy(() => preloadPhase('SHOWCASE')),
  ROUND_RESULTS: lazy(() => preloadPhase('ROUND_RESULTS')),
  FINAL: lazy(() => preloadPhase('FINAL')),
};

/** What can come after each phase. */
const NEXT: Record<Phase, LazyPhase[]> = {
  LOBBY: ['DUBBING'],
  DUBBING: ['SHOWCASE'],
  SHOWCASE: ['ROUND_RESULTS', 'FINAL'],
  ROUND_RESULTS: ['DUBBING', 'FINAL'],
  FINAL: [],
};

/** Run `fn` when the main thread is idle (or after `timeoutMs` at the latest). */
export function whenIdle(fn: () => void, timeoutMs = 1500): () => void {
  if (typeof requestIdleCallback === 'function') {
    const h = requestIdleCallback(fn, { timeout: timeoutMs });
    return () => cancelIdleCallback(h);
  }
  const t = setTimeout(fn, 200);
  return () => clearTimeout(t);
}

/** Prefetches the chunks of the phases that can follow `phase`, once the page is idle. */
export function prefetchAfter(phase: Phase): () => void {
  return whenIdle(() => {
    for (const next of NEXT[phase]) void preloadPhase(next).catch(() => undefined);
  });
}
