// App-wide AudioContext. Created by T10 (minimal), owned by T11.

let ctx: AudioContext | null = null;
const listeners = new Set<(state: AudioContextState | 'none') => void>();

function notify() {
  const s = ctx?.state ?? 'none';
  for (const fn of [...listeners]) fn(s);
}

/** The single AudioContext (created lazily, possibly `suspended` until a gesture). */
export function getAudioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    ctx.addEventListener('statechange', notify);
    notify();
  }
  return ctx;
}

/** Whether WebAudio exists at all in this browser. */
export function hasWebAudio(): boolean {
  return typeof AudioContext !== 'undefined';
}

/**
 * Call synchronously inside a user gesture handler (Create/Join/MicCheck click, the
 * "Tap to enable sound" overlay): creates and resumes the context so playback is allowed.
 */
export function unlockAudio(): Promise<boolean> {
  if (!hasWebAudio()) return Promise.resolve(false);
  try {
    const c = getAudioContext();
    if (c.state === 'running') return Promise.resolve(true);
    return c.resume().then(
      () => {
        notify();
        return c.state === 'running';
      },
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

export function isAudioRunning(): boolean {
  return ctx?.state === 'running';
}

/** 'none' until the context exists. */
export function audioState(): AudioContextState | 'none' {
  return ctx?.state ?? 'none';
}

export function onAudioStateChange(fn: (state: AudioContextState | 'none') => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
