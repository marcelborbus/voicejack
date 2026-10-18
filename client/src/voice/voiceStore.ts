import type { PlayerId } from '@dub/shared';
import { create } from 'zustand';

export type PeerState = 'connecting' | 'connected' | 'failed';

export interface VoiceState {
  /** Whether a mesh is running (inside a room). */
  active: boolean;
  peers: Record<PlayerId, PeerState>;
  speaking: Record<PlayerId, boolean>;
  selfSpeaking: boolean;
  selfMuted: boolean;
  /** Per-peer local mute (only affects what you hear). */
  peerMuted: Record<PlayerId, boolean>;
  /** Per-peer local playback volume 0–1 (absent = 1; #43). */
  peerVolume: Record<PlayerId, number>;
  /** Voice currently allowed by the phase policy. */
  allowed: boolean;
}

export const useVoice = create<VoiceState>(() => ({
  active: false,
  peers: {},
  speaking: {},
  selfSpeaking: false,
  selfMuted: false,
  peerMuted: {},
  peerVolume: {},
  allowed: false,
}));

export function toggleSelfMute(): void {
  useVoice.setState((s) => ({ selfMuted: !s.selfMuted }));
}

export function togglePeerMute(id: PlayerId): void {
  useVoice.setState((s) => ({ peerMuted: { ...s.peerMuted, [id]: !s.peerMuted[id] } }));
}

export function setPeerVolume(id: PlayerId, volume: number): void {
  useVoice.setState((s) => ({ peerVolume: { ...s.peerVolume, [id]: volume } }));
}
