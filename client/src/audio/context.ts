// Minimal version created by T10; T11 owns and extends this file.

let ctx: AudioContext | null = null;

/** The app-wide AudioContext (created lazily). */
export function getAudioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  return ctx;
}

/**
 * Call synchronously inside a user gesture handler (Create/Join/MicCheck click): creates and
 * resumes the context so later playback is allowed by autoplay policies.
 */
export function unlockAudio(): void {
  try {
    const c = getAudioContext();
    if (c.state !== 'running') void c.resume().catch(() => undefined);
  } catch {
    /* no WebAudio: the overlay (T11) will tell the user */
  }
}

export function isAudioRunning(): boolean {
  return ctx?.state === 'running';
}
