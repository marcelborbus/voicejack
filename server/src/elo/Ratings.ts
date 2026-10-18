import { nanoid } from 'nanoid';
import type { GameEloResult, QueueMode } from '@dub/shared';
import { tx, type Db } from '../db/index.js';
import { pairwiseElo, placesOf, type EloChange } from './elo.js';

/** One seat of a finished game, as the room reports it at FINAL. */
export interface FinishedSeat {
  userId: string | null;
  isBot: boolean;
  total: number;
  roundWins: number;
}

export interface FinishedGame {
  kind: QueueMode;
  roomCode: string;
  /** Everyone still on the roster at FINAL (disconnected players included). */
  seats: readonly FinishedSeat[];
}

export interface RecordedGame {
  gameId: string;
  changes: (EloChange & { place: number; total: number })[];
}

export interface Rating {
  elo: number;
  publicGamesPlayed: number;
}

/**
 * Elo + game history (V09, `006_games.sql`) on top of `users.elo` / `public_games_played`.
 * Only public games are recorded (RoomManager calls `recordGame` for public rooms only).
 */
export class Ratings {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Live user's rating, or null (unknown or deleted). */
  ratingOf(userId: string): Rating | null {
    const r = this.db
      .prepare('SELECT elo, public_games_played FROM users WHERE id = ? AND deleted_at IS NULL')
      .get(userId) as { elo: number; public_games_played: number } | undefined;
    return r ? { elo: r.elo, publicGamesPlayed: r.public_games_played } : null;
  }

  /**
   * Rates a finished public game: places come from the final totals (ties share a place),
   * then pairwise Elo among the humans with a live account row (bots and account-less seats
   * are left out; one seat per account). Writes `games` + `game_players`, updates `elo` and
   * `public_games_played += 1`. Returns null (nothing written) when nobody is rated.
   */
  recordGame(g: FinishedGame): RecordedGame | null {
    const places = placesOf(g.seats);
    const seen = new Set<string>();
    const seats = g.seats
      .map((s, i) => ({ ...s, place: places[i]! }))
      .filter((s): s is typeof s & { userId: string } => {
        if (s.isBot || !s.userId || seen.has(s.userId)) return false;
        seen.add(s.userId);
        return true;
      });
    if (seats.length === 0) return null;
    return tx(this.db, () => {
      const rated = seats
        .map((s) => ({ s, r: this.ratingOf(s.userId) }))
        .filter((x): x is { s: (typeof seats)[number]; r: Rating } => x.r !== null);
      if (rated.length === 0) return null;
      const changes = pairwiseElo(
        rated.map(({ s, r }) => ({ id: s.userId, rating: r.elo, place: s.place })),
      );
      const gameId = nanoid(16);
      this.db
        .prepare('INSERT INTO games (id, kind, room_code, created_at) VALUES (?, ?, ?, ?)')
        .run(gameId, g.kind, g.roomCode, this.now());
      const ins = this.db.prepare(
        `INSERT INTO game_players (game_id, user_id, place, total, elo_before, elo_after)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const upd = this.db.prepare(
        'UPDATE users SET elo = ?, public_games_played = public_games_played + 1 WHERE id = ?',
      );
      const out: RecordedGame['changes'] = [];
      rated.forEach(({ s }, i) => {
        const c = changes[i]!;
        ins.run(gameId, c.id, s.place, s.total, c.before, c.after);
        upd.run(c.after, c.id);
        out.push({ ...c, place: s.place, total: s.total });
      });
      return { gameId, changes: out };
    });
  }

  /** `userId`'s result in the latest recorded game of room `roomCode`, or null. */
  lastGame(userId: string, roomCode: string): GameEloResult | null {
    const r = this.db
      .prepare(
        `SELECT g.id, g.kind, g.room_code, g.created_at, gp.place, gp.total, gp.elo_before,
                gp.elo_after,
                (SELECT COUNT(*) FROM game_players x WHERE x.game_id = g.id) AS players
         FROM game_players gp JOIN games g ON g.id = gp.game_id
         WHERE gp.user_id = ? AND g.room_code = ?
         ORDER BY g.created_at DESC LIMIT 1`,
      )
      .get(userId, roomCode) as
      | {
          kind: QueueMode;
          room_code: string;
          created_at: number;
          place: number;
          total: number;
          elo_before: number;
          elo_after: number;
          players: number;
        }
      | undefined;
    if (!r) return null;
    return {
      kind: r.kind,
      roomCode: r.room_code,
      createdAt: r.created_at,
      place: r.place,
      players: Number(r.players),
      total: r.total,
      eloBefore: r.elo_before,
      eloAfter: r.elo_after,
    };
  }
}
