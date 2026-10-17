import { createHash, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import { tx, type Db } from '../db/index.js';
import { readCookie, SESSION_COOKIE } from './cookies.js';

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** A session with less than this left is extended to a fresh 30 days on use. */
export const SESSION_REFRESH_MS = 15 * 24 * 3600_000;
/** Guests not seen for this long are deleted by the cleanup timer. */
export const GUEST_RETENTION_MS = 180 * 24 * 3600_000;
/** Magic-link lifetime (V04). */
export const LOGIN_TOKEN_TTL_MS = 15 * 60_000;
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

  // ---------- V04: magic links, logout, deletion ----------

  /** Stores a 15-min single-use login token for `email`; returns the secret (hash stored). */
  createLoginToken(email: string, guestUserId: string | null): string {
    const token = randomBytes(32).toString('base64url');
    const t = this.now();
    this.db
      .prepare(
        'INSERT INTO login_tokens (id, email, guest_user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(hashToken(token), email, guestUserId, t, t + LOGIN_TOKEN_TTL_MS);
    return token;
  }

  /** Login tokens requested for `email` within the last `windowMs` (rate limit). */
  loginTokensSince(email: string, windowMs: number): number {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > ?')
      .get(email, this.now() - windowMs) as { n: number };
    return Number(r.n);
  }

  /** Email of a still-usable token (confirm page), without consuming it. */
  peekLoginToken(token: string): string | null {
    if (!token || token.length > 128) return null;
    const r = this.db
      .prepare('SELECT email FROM login_tokens WHERE id = ? AND used_at IS NULL AND expires_at > ?')
      .get(hashToken(token), this.now()) as { email: string } | undefined;
    return r?.email ?? null;
  }

  /**
   * Consumes a login token (single use) and returns the account to sign in to, or null if the
   * token is unknown, used or expired. Every other open token for the address is burnt too.
   *
   * - No registered account with that email: the requesting guest row is claimed (kind
   *   registered, email set; Elo and history stay). If that guest is gone (or meanwhile
   *   registered under another address), a fresh registered user is created.
   * - The email already has an account: that account wins. Merge rule (documented in
   *   db/README.md): its Elo / public_games_played are kept, except when it has never played a
   *   public game and the guest has, then it takes the guest's; its empty display name takes
   *   the guest's. The guest row is left as an orphan guest (purged by the 180-day cleanup).
   *
   * All sessions of the claimed/merged guest end (the caller then issues a fresh one), so a
   * link someone else requested can't leave their browser signed in to your address.
   */
  consumeLoginToken(token: string): { user: User; merged: boolean } | null {
    if (!token || token.length > 128) return null;
    const id = hashToken(token);
    return tx(this.db, () => {
      const t = this.now();
      const row = this.db
        .prepare('SELECT * FROM login_tokens WHERE id = ? AND used_at IS NULL AND expires_at > ?')
        .get(id, t) as { email: string; guest_user_id: string | null } | undefined;
      if (!row) return null;
      this.db
        .prepare('UPDATE login_tokens SET used_at = ? WHERE email = ? AND used_at IS NULL')
        .run(t, row.email);
      const existing = this.db
        .prepare("SELECT * FROM users WHERE email = ? AND kind = 'registered' AND deleted_at IS NULL")
        .get(row.email) as UserRow | undefined;
      let guest = row.guest_user_id ? this.getUser(row.guest_user_id) : null;
      if (guest && guest.kind !== 'guest') guest = null;
      if (guest) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(guest.id);

      if (existing) {
        if (guest && existing.id !== guest.id) {
          if (existing.public_games_played === 0 && guest.publicGamesPlayed > 0) {
            this.db
              .prepare('UPDATE users SET elo = ?, public_games_played = ? WHERE id = ?')
              .run(guest.elo, guest.publicGamesPlayed, existing.id);
          }
          if (!existing.display_name && guest.displayName) {
            this.db
              .prepare('UPDATE users SET display_name = ? WHERE id = ?')
              .run(guest.displayName, existing.id);
          }
        }
        this.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(t, existing.id);
        return { user: this.getUser(existing.id)!, merged: true };
      }
      if (guest) {
        this.db
          .prepare("UPDATE users SET kind = 'registered', email = ?, last_seen_at = ? WHERE id = ?")
          .run(row.email, t, guest.id);
        return { user: this.getUser(guest.id)!, merged: false };
      }
      const uid = nanoid(16);
      this.db
        .prepare(
          "INSERT INTO users (id, kind, email, created_at, last_seen_at) VALUES (?, 'registered', ?, ?, ?)",
        )
        .run(uid, row.email, t, t);
      return { user: this.getUser(uid)!, merged: false };
    });
  }

  /** Ends one session (logout / rotation). */
  deleteSession(token: string | null | undefined): void {
    if (!token || token.length > 128) return;
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token));
  }

  /**
   * Account deletion: anonymizes the row (email and name cleared, kind guest, deleted_at set),
   * ends every session and drops pending login tokens for the address. The row itself stays
   * so future references (V09 game history) don't dangle; it no longer resolves anywhere.
   */
  deleteAccount(userId: string): void {
    tx(this.db, () => {
      const u = this.getUser(userId);
      if (!u) return;
      if (u.email) this.db.prepare('DELETE FROM login_tokens WHERE email = ?').run(u.email);
      this.db.prepare('DELETE FROM login_tokens WHERE guest_user_id = ?').run(userId);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      this.db
        .prepare(
          "UPDATE users SET email = NULL, display_name = '', kind = 'guest', deleted_at = ? WHERE id = ?",
        )
        .run(this.now(), userId);
    });
  }

  /** Deletes expired sessions and login tokens and long-idle guests. Returns the counts. */
  cleanup(): { sessions: number; guests: number; loginTokens: number } {
    const t = this.now();
    const s = this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(t);
    // Kept one window past expiry so the per-address rate limit still counts them.
    const l = this.db
      .prepare('DELETE FROM login_tokens WHERE expires_at <= ?')
      .run(t - LOGIN_TOKEN_TTL_MS);
    const g = this.db
      .prepare("DELETE FROM users WHERE kind = 'guest' AND last_seen_at < ?")
      .run(t - GUEST_RETENTION_MS);
    return { sessions: Number(s.changes), guests: Number(g.changes), loginTokens: Number(l.changes) };
  }
}
