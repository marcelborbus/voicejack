import {
  LIMITS,
  type IceServer,
  type Limits,
  type PlayerPublic,
  type RoomSnapshot,
} from '@dub/shared';
import { create } from 'zustand';
import type { ConnStatus, FatalError } from '@/net/socket';

export interface RoomState {
  /** Room this tab is in (set by `joinRoom`), uppercase. */
  code: string | null;
  status: ConnStatus;
  /** Set when the session ended for good (room gone, kicked, bad token, …). */
  fatal: FatalError | null;
  snapshot: RoomSnapshot | null;
  playerId: string | null;
  iceServers: IceServer[];
  limits: Limits;
  /** Last `voteAck` from the server (showcase). */
  lastVoteAck: { submissionId: string; score: number } | null;
}

export const initialRoomState: RoomState = {
  code: null,
  status: 'idle',
  fatal: null,
  snapshot: null,
  playerId: null,
  iceServers: [],
  limits: LIMITS,
  lastVoteAck: null,
};

export const useRoomStore = create<RoomState>(() => ({ ...initialRoomState }));

/** Generic selector hook. Return primitives or stable references from the snapshot. */
export function useRoom<T>(selector: (s: RoomState) => T): T {
  return useRoomStore(selector);
}

// ---------- selectors ----------
export const selectSnapshot = (s: RoomState) => s.snapshot;
export const selectPhase = (s: RoomState) => s.snapshot?.phase ?? null;
export const selectPlayers = (s: RoomState) => s.snapshot?.players ?? EMPTY_PLAYERS;
export const selectYou = (s: RoomState) => s.snapshot?.you ?? null;
export const selectMe = (s: RoomState): PlayerPublic | null => {
  const snap = s.snapshot;
  if (!snap) return null;
  return snap.players.find((p) => p.id === snap.you.playerId) ?? null;
};
export const selectIsHost = (s: RoomState) =>
  !!s.snapshot && s.snapshot.hostId === s.snapshot.you.playerId;

const EMPTY_PLAYERS: PlayerPublic[] = [];

export const useSnapshot = () => useRoomStore(selectSnapshot);
export const usePhase = () => useRoomStore(selectPhase);
export const usePlayers = () => useRoomStore(selectPlayers);
export const useYou = () => useRoomStore(selectYou);
export const useMe = () => useRoomStore(selectMe);
export const useIsHost = () => useRoomStore(selectIsHost);
export const useConnStatus = () => useRoomStore((s) => s.status);
