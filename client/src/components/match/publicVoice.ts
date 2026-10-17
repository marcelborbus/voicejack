import { useEffect } from 'react';
import { create } from 'zustand';
import { useRoomStore } from '@/state/room';
import { useVoice } from '@/voice/voiceStore';

/** Public rooms: are other players audible by default ("tap to listen")? */
export const usePublicListen = create<{ on: boolean }>(() => ({ on: false }));

/**
 * Public rooms (V08, owner decision): voice is opt-in. Your mic starts muted and every other
 * player starts muted for you until you tap "listen" (or unmute them one by one).
 * Runs while mounted; restores the private-room defaults on unmount.
 */
export function usePublicVoiceDefaults(): void {
  useEffect(() => {
    const seen = new Set<string>();
    const muteNew = () => {
      const s = useRoomStore.getState().snapshot;
      if (!s) return;
      const add: Record<string, boolean> = {};
      for (const p of s.players) {
        if (p.id === s.you.playerId || seen.has(p.id)) continue;
        seen.add(p.id);
        // New arrivals follow the current "listen" choice.
        add[p.id] = !usePublicListen.getState().on;
      }
      if (Object.keys(add).length)
        useVoice.setState((v) => ({ peerMuted: { ...v.peerMuted, ...add } }));
    };
    usePublicListen.setState({ on: false });
    useVoice.setState({ selfMuted: true, peerMuted: {} });
    muteNew();
    const unsub = useRoomStore.subscribe(muteNew);
    return () => {
      unsub();
      usePublicListen.setState({ on: false });
      useVoice.setState({ selfMuted: false, peerMuted: {} });
    };
  }, []);
}

/** "Tap to listen": unmute (or mute) everyone at once. */
export function setListenAll(on: boolean): void {
  const s = useRoomStore.getState().snapshot;
  const peerMuted: Record<string, boolean> = {};
  for (const p of s?.players ?? []) if (p.id !== s?.you.playerId) peerMuted[p.id] = !on;
  usePublicListen.setState({ on });
  useVoice.setState({ peerMuted });
}
