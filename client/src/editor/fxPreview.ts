import type { FxId } from '@dub/shared';
import { getAudioContext, unlockAudio } from '@/audio/context';
import { fxCache } from '@/dub/fx';
import { transport, type EditorChunk } from './editorStore';

/** #48: tapping an effect tile plays ~2 s of a take with that effect (straight to the speakers). */
const PREVIEW_SEC = 2;
const FADE_SEC = 0.15;

let current: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
let token = 0;

export function stopFxPreview(): void {
  token++;
  if (!current) return;
  const { src, gain } = current;
  current = null;
  try {
    const now = src.context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + 0.03);
    src.stop(now + 0.04);
  } catch {
    /* already stopped */
  }
}

export async function previewFx(chunk: EditorChunk, fx: FxId): Promise<void> {
  stopFxPreview();
  const my = token;
  const dry = chunk.buffer;
  if (!dry) return;
  void unlockAudio();
  transport.pause();
  let buffer: AudioBuffer = dry;
  let from = chunk.meta.offsetMs / 1000;
  let len = Math.min(PREVIEW_SEC, chunk.meta.durationMs / 1000);
  if (fx !== 'none') {
    try {
      const p = await fxCache.get({ ...chunk.meta, fx }, dry)!;
      buffer = p.buffer;
      // Ghost: start a bit into the swell so it is heard before the words.
      const lead = p.leadMs / 1000;
      from = Math.max(0, lead - 0.6);
      len += lead - from + Math.min(0.8, p.tailMs / 1000);
    } catch {
      return;
    }
  }
  if (my !== token) return; // another tile was tapped meanwhile
  const ctx = getAudioContext();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const gain = ctx.createGain();
  src.connect(gain);
  gain.connect(ctx.destination);
  const t = ctx.currentTime + 0.01;
  gain.gain.setValueAtTime(1, t);
  gain.gain.setValueAtTime(1, t + Math.max(0, len - FADE_SEC));
  gain.gain.linearRampToValueAtTime(0, t + len);
  src.start(t, from, len);
  const entry = { src, gain };
  current = entry;
  src.onended = () => {
    src.disconnect();
    gain.disconnect();
    if (current === entry) current = null;
  };
}
