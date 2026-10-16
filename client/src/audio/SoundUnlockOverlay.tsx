import { Volume2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  audioState,
  getAudioContext,
  hasWebAudio,
  onAudioStateChange,
  unlockAudio,
} from './context';

/**
 * Full-screen "Tap to enable sound" overlay, shown while the AudioContext is not running
 * (e.g. after a reload, when the browser blocks audio until a gesture). Mount it in the room.
 */
export function SoundUnlockOverlay() {
  const [state, setState] = useState(audioState);

  useEffect(() => {
    if (!hasWebAudio()) return;
    getAudioContext(); // make sure it exists so we can see whether it is running
    setState(audioState());
    const off = onAudioStateChange(setState);
    // Some browsers report 'running' a moment after creation.
    const t = setTimeout(() => setState(audioState()), 300);
    return () => {
      off();
      clearTimeout(t);
    };
  }, []);

  if (!hasWebAudio() || state === 'running' || state === 'none' || state === 'closed') return null;
  return (
    <button
      type="button"
      data-testid="sound-unlock"
      onClick={() => void unlockAudio().then(() => setState(audioState()))}
      className="fixed inset-0 z-[90] flex animate-overlay-in flex-col items-center justify-center gap-5 bg-zinc-950/85 text-center backdrop-blur-md"
    >
      <span className="inline-flex size-24 animate-pulse-ring items-center justify-center rounded-[2rem] bg-brand shadow-2xl shadow-fuchsia-500/40">
        <Volume2 className="size-11 text-white" />
      </span>
      <span className="font-display text-3xl font-bold">Tap to enable sound</span>
      <span className="max-w-xs text-sm text-zinc-400">
        Your browser keeps the party quiet until you tap once.
      </span>
    </button>
  );
}
