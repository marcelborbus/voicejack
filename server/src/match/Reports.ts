import type { Db } from '../db/index.js';
import type { PlayerReport } from '../room/types.js';

export interface ReportRow {
  id: number;
  createdAt: number;
  roomCode: string | null;
  reporterUserId: string | null;
  reporterName: string;
  reportedUserId: string | null;
  reportedName: string;
  reason: string;
}

/** `reports` table (V08, migration 003): player reports from public games. */
export class Reports {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  add(r: PlayerReport): number {
    // A user id that is not (or no longer) in `users` must not fail the insert.
    const known = (id: string | null) =>
      id && this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(id) ? id : null;
    const res = this.db
      .prepare(
        `INSERT INTO reports (created_at, context, room_code, reporter_user_id, reporter_name,
           reported_user_id, reported_name, reason) VALUES (?, 'room', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.now(),
        r.code,
        known(r.reporterUserId),
        r.reporterName,
        known(r.reportedUserId),
        r.reportedName,
        r.reason,
      );
    return Number(res.lastInsertRowid);
  }

  /** Newest first. */
  list(limit = 100): ReportRow[] {
    return this.db
      .prepare(
        `SELECT id, created_at AS createdAt, room_code AS roomCode,
           reporter_user_id AS reporterUserId, reporter_name AS reporterName,
           reported_user_id AS reportedUserId, reported_name AS reportedName, reason
         FROM reports ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as unknown as ReportRow[];
  }
}
