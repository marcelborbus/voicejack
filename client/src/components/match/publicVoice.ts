import { useEffect } from 'react';
import { create } from 'zustand';
import { useRoomStore } from '@/state/room';
import { setSticky } from '@/state/session';
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
    // V13: tapping "talk" or "listen" opts in to voice; only two opted-in players open a peer
    // connection (which exposes IPs). Mic off and not listening again = opted out.
    const syncOptIn = () => {
      const s = useRoomStore.getState().snapshot;
      if (!s?.public) return;
      const want = !useVoice.getState().selfMuted || usePublicListen.getState().on;
      const self = s.players.find((p) => p.id === s.you.playerId);
      // Sticky: re-sent after a reconnect.
      if (!!self?.voiceOptIn !== want) setSticky('voiceOptIn', { t: 'voiceOptIn', on: want });
    };
    const unsubOpt = [
      useVoice.subscribe((v, prev) => v.selfMuted !== prev.selfMuted && syncOptIn()),
      usePublicListen.subscribe(syncOptIn),
    ];
    syncOptIn();
    return () => {
      for (const u of unsubOpt) u();
      setSticky('voiceOptIn', null);
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
