import { createHash, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Db } from '../db/index.js';
import { readCookie, SESSION_COOKIE } from './cookies.js';

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** A session with less than this left is extended to a fresh 30 days on use. */
export const SESSION_REFRESH_MS = 15 * 24 * 3600_000;
/** Guests not seen for this long are deleted by the cleanup timer. */
export const GUEST_RETENTION_MS = 180 * 24 * 3600_000;
/** `last_seen_at` is written at most this often per user. */
const TOUCH_EVERY_MS = 3600_000;

export type UserKind = 'guest' | 'registered';

export interface User {
  id: string;
  kind: UserKind;
  displayName: string;
  email: string | null;
  createdAt: number;
  lastSeenAt: number;
  elo: number;
  publicGamesPlayed: number;
}

interface UserRow {
  id: string;
  kind: UserKind;
  display_name: string;
  email: string | null;
  created_at: number;
  last_seen_at: number;
  elo: number;
  public_games_played: number;
}

export interface SessionInfo {
  user: User;
  expiresAt: number;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toUser(r: UserRow): User {
  return {
    id: r.id,
    kind: r.kind,
    displayName: r.display_name,
    email: r.email,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    elo: r.elo,
    publicGamesPlayed: r.public_games_played,
  };
}

/** Users + sessions on top of the SQLite DB. All methods are synchronous. */
export class Accounts {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  createGuest(): User {
    const t = this.now();
    const id = nanoid(16);
    this.db
      .prepare('INSERT INTO users (id, kind, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
      .run(id, 'guest', t, t);
    return this.getUser(id)!;
  }

  /** Live (not deleted) user by id. */
  getUser(id: string): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(id) as
      UserRow | undefined;
    return r ? toUser(r) : null;
  }

  /** New session for `userId`; returns the cookie token (only its hash is stored). */
  createSession(userId: string): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url');
    const t = this.now();
    const expiresAt = t + SESSION_TTL_MS;
    this.db
      .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(hashToken(token), userId, t, expiresAt);
    return { token, expiresAt };
  }

  /** Resolves a session token to its live user, or null (unknown, expired, deleted user). */
  session(token: string | null | undefined): SessionInfo | null {
    if (!token || token.length > 128) return null;
    const r = this.db
      .prepare(
        `SELECT u.*, s.expires_at AS s_expires FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = ? AND s.expires_at > ? AND u.deleted_at IS NULL`,
      )
      .get(hashToken(token), this.now()) as (UserRow & { s_expires: number }) | undefined;
    return r ? { user: toUser(r), expiresAt: r.s_expires } : null;
  }

  /** User id behind the `vj_session` cookie in a raw `Cookie:` header (WS upgrade). */
  userIdFromCookie(header: string | undefined): string | null {
    return this.session(readCookie(header, SESSION_COOKIE))?.user.id ?? null;
  }

  /** Pushes the session's expiry to now + 30 d if it has less than 15 d left. */
  refreshSession(token: string, s: SessionInfo): number | null {
    const t = this.now();
    if (s.expiresAt - t >= SESSION_REFRESH_MS) return null;
    const expiresAt = t + SESSION_TTL_MS;
    this.db
      .prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .run(expiresAt, hashToken(token));
    return expiresAt;
  }

  /** Updates `last_seen_at` (at most hourly). */
  touch(user: User): void {
    const t = this.now();
    if (t - user.lastSeenAt < TOUCH_EVERY_MS) return;
    this.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(t, user.id);
    user.lastSeenAt = t;
  }

  setDisplayName(userId: string, name: string): void {
    this.db
      .prepare('UPDATE users SET display_name = ? WHERE id = ? AND display_name <> ?')
      .run(name, userId, name);
  }

  /** Deletes expired sessions and long-idle guests (login_tokens are V04's). Returns the counts. */
  cleanup(): { sessions: number; guests: number } {
    const t = this.now();
    const s = this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(t);
    const g = this.db
      .prepare("DELETE FROM users WHERE kind = 'guest' AND last_seen_at < ?")
      .run(t - GUEST_RETENTION_MS);
    return { sessions: Number(s.changes), guests: Number(g.changes) };
  }
}
