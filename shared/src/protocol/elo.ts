import { z } from 'zod';

/**
 * V09 Elo + ranked matchmaking. Every public game (casual or ranked) updates the players'
 * rating (`users.elo`, start {@link ELO_START}) with pairwise multiplayer Elo; private games
 * never do. Ranked unlocks after {@link RANKED_MIN_GAMES} public games.
 */
export const ELO_START = 1000;
export const RANKED_MIN_GAMES = 3;

/** `queueJoin.mode`: casual (V08, anyone) or ranked (Elo window, unlocked after 3 games). */
export const QueueModeSchema = z.enum(['casual', 'ranked']);
export type QueueMode = z.infer<typeof QueueModeSchema>;

/** Ranked is offered (Home button, server accepts `mode: 'ranked'`). */
export function rankedUnlocked(user: { publicGamesPlayed: number } | null | undefined): boolean {
  return !!user && user.publicGamesPlayed >= RANKED_MIN_GAMES;
}

/** `GET /api/me/last-game?room=CODE`: your result of the latest public game in that room. */
export const LAST_GAME_PATH = '/api/me/last-game';

export interface GameEloResult {
  kind: QueueMode;
  roomCode: string;
  createdAt: number;
  /** 1-based; tied players share a place. */
  place: number;
  /** Rated players in the game (humans with an account). */
  players: number;
  total: number;
  eloBefore: number;
  eloAfter: number;
}

export interface LastGameResponse {
  game: GameEloResult | null;
}

/** "+19", "−7", "±0". */
export function formatEloDelta(delta: number): string {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `−${-delta}`;
  return '±0';
}
