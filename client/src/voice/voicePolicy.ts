import { voiceAllowed, type Phase, type PlayerId, type PlayerPublic } from '@dub/shared';

export interface VoiceGate {
  /** Outgoing (cloned) mic track `enabled`. */
  send: boolean;
  /** Remote audio audible at all (each element is additionally muted per peer). */
  play: boolean;
}

/**
 * Pure muting policy. Voice is on in every phase except DUBBING (shared `voiceAllowed`), and
 * off everywhere while we are not in a room phase yet. A player the host muted for everyone
 * (#43) sends nothing.
 */
export function voiceGate(phase: Phase | null, selfMuted: boolean, mutedByHost = false): VoiceGate {
  const allowed = phase !== null && voiceAllowed(phase);
  return { send: allowed && !selfMuted && !mutedByHost, play: allowed };
}

/**
 * Effective `muted` for one remote audio element: our own per-peer mute, or the host muted
 * that player for everyone (#43; enforced here too, in case their client still sends).
 */
export function remoteMuted(gate: VoiceGate, peerMuted: boolean, mutedByHost = false): boolean {
  return !gate.play || peerMuted || mutedByHost;
}

/** Per-peer playback volume (0–1, default 1) for `HTMLMediaElement.volume`. */
export function peerVolume(v: number | undefined): number {
  return v === undefined || !Number.isFinite(v) ? 1 : Math.min(1, Math.max(0, v));
}

/** Players the host muted for everyone, from the snapshot (#43). */
export function hostMutedIds(players: readonly PlayerPublic[]): Set<PlayerId> {
  return new Set(players.filter((p) => p.mutedByHost).map((p) => p.id));
}

/** Perfect negotiation roles: the player with the lower id is polite. */
export function isPolite(selfId: PlayerId, peerId: PlayerId): boolean {
  return selfId < peerId;
}

/**
 * Which peers we want: every other connected player (server-side bots never do voice). In
 * public rooms (V13) only when both we and they opted in to voice: a peer connection exposes
 * IP addresses even while muted, so strangers connect only after both said yes.
 */
export function desiredPeers(
  players: readonly PlayerPublic[],
  selfId: PlayerId,
  publicRoom = false,
): Set<PlayerId> {
  if (publicRoom && !players.find((p) => p.id === selfId)?.voiceOptIn) return new Set();
  return new Set(
    players
      .filter((p) => p.id !== selfId && p.connected && !p.isBot && (!publicRoom || p.voiceOptIn))
      .map((p) => p.id),
  );
}

/** Roster diff: which peer connections to open and which to close. */
export function diffPeers(
  current: Iterable<PlayerId>,
  players: readonly PlayerPublic[],
  selfId: PlayerId,
  publicRoom = false,
): { open: PlayerId[]; close: PlayerId[] } {
  const want = desiredPeers(players, selfId, publicRoom);
  const have = new Set(current);
  return {
    open: [...want].filter((id) => !have.has(id)).sort(),
    close: [...have].filter((id) => !want.has(id)).sort(),
  };
}
