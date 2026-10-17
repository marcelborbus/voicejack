import { voiceAllowed, type Phase, type PlayerId, type PlayerPublic } from '@dub/shared';

export interface VoiceGate {
  /** Outgoing (cloned) mic track `enabled`. */
  send: boolean;
  /** Remote audio audible at all (each element is additionally muted per peer). */
  play: boolean;
}

/**
 * Pure muting policy. Voice is on in every phase except DUBBING (shared `voiceAllowed`), and
 * off everywhere while we are not in a room phase yet.
 */
export function voiceGate(phase: Phase | null, selfMuted: boolean): VoiceGate {
  const allowed = phase !== null && voiceAllowed(phase);
  return { send: allowed && !selfMuted, play: allowed };
}

/** Effective `muted` for one remote audio element. */
export function remoteMuted(gate: VoiceGate, peerMuted: boolean): boolean {
  return !gate.play || peerMuted;
}

/** Perfect negotiation roles: the player with the lower id is polite. */
export function isPolite(selfId: PlayerId, peerId: PlayerId): boolean {
  return selfId < peerId;
}

/** Which peers we want: every other connected player (server-side bots never do voice). */
export function desiredPeers(players: readonly PlayerPublic[], selfId: PlayerId): Set<PlayerId> {
  return new Set(
    players.filter((p) => p.id !== selfId && p.connected && !p.isBot).map((p) => p.id),
  );
}

/** Roster diff: which peer connections to open and which to close. */
export function diffPeers(
  current: Iterable<PlayerId>,
  players: readonly PlayerPublic[],
  selfId: PlayerId,
): { open: PlayerId[]; close: PlayerId[] } {
  const want = desiredPeers(players, selfId);
  const have = new Set(current);
  return {
    open: [...want].filter((id) => !have.has(id)).sort(),
    close: [...have].filter((id) => !want.has(id)).sort(),
  };
}
