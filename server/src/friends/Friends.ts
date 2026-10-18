import { createHash } from 'node:crypto';
import {
  DM_MAX_LENGTH,
  DM_PAGE_SIZE,
  DMS_PER_MINUTE,
  FRIEND_REQUESTS_PER_DAY,
  FRIEND_SEARCH_MAX_RESULTS,
  FRIEND_SEARCH_MIN,
  FRIEND_SEARCHES_PER_MINUTE,
  INVITES_PER_MINUTE,
  sanitizeDmBody,
  type AddFromRoomResponse,
  type DirectMessage,
  type ErrorCode,
  type FriendRefInfo,
  type FriendSearchResult,
  type FriendsResponse,
  type FriendStatus,
  type MessagesResponse,
  type PlayerId,
  type RequestActionBody,
  type RoomCode,
  type RoomRelation,
} from '@dub/shared';
import { tx, type Db } from '../db/index.js';
import type { Presence } from '../presence/Presence.js';
import type { RoomManager } from '../room/RoomManager.js';

const DAY_MS = 24 * 3600_000;
const REPORTS_PER_HOUR = 10;
/** How long a search result's `ref` can be used for `addByRef`. */
const SEARCH_REF_TTL_MS = 30 * 60_000;
const SEARCH_REF_MAX = 200;

/** `LIKE` pattern for a literal prefix (`\` escapes). */
const likePrefix = (q: string): string => q.replace(/[\\%_]/g, (c) => `\\${c}`) + '%';
/** Unicode-aware case fold for names (SQLite's own lower()/LIKE only fold ASCII). */
const fold = (s: string): string => s.normalize('NFC').toLocaleLowerCase('en');

export class FriendsError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, code: ErrorCode, message: string): never => {
  throw new FriendsError(status, code, message);
};

/** Sliding-window counter per key (in memory: limits reset on restart, which is fine). */
export class WindowLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number,
  ) {}
  take(key: string): boolean {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits)
        if (!v.some((x) => x > t - this.windowMs)) this.hits.delete(k);
    }
    return true;
  }
}

interface FriendshipRow {
  user_a: string;
  user_b: string;
  requested_by: string;
  status: 'pending' | 'accepted';
  created_at: number;
  accepted_at: number | null;
}
interface MessageRow {
  id: number;
  sender: string;
  recipient: string;
  body: string;
  created_at: number;
  read_at: number | null;
}

const pair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);
const toMessage = (r: MessageRow): DirectMessage => ({
  id: r.id,
  from: r.sender,
  to: r.recipient,
  body: r.body,
  at: r.created_at,
  readAt: r.read_at,
});

export interface FriendsDeps {
  db: Db;
  presence?: Presence;
  rooms?: RoomManager;
  now?: () => number;
}

/**
 * V10 friends, blocks, DMs and invites for registered users. Callers pass `me` = the session's
 * registered user id (routes check `kind`). Throws `FriendsError` (status + code) on refusal.
 *
 * Pending requests and blocks are addressed by `ref` = a hash of the ordered pair, so the other
 * side's account id is never sent before a request is accepted.
 */
export class Friends {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly requestLimit: WindowLimiter;
  private readonly dmLimit: WindowLimiter;
  private readonly inviteLimit: WindowLimiter;
  private readonly reportLimit: WindowLimiter;
  private readonly searchLimit: WindowLimiter;
  /** Per searcher: refs handed out by `search` → target user id (in memory, short-lived). */
  private readonly searchRefs = new Map<string, Map<string, { userId: string; at: number }>>();
  private readonly unsubscribe: (() => void) | null;

  constructor(private readonly deps: FriendsDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.requestLimit = new WindowLimiter(FRIEND_REQUESTS_PER_DAY, DAY_MS, this.now);
    this.dmLimit = new WindowLimiter(DMS_PER_MINUTE, 60_000, this.now);
    this.inviteLimit = new WindowLimiter(INVITES_PER_MINUTE, 60_000, this.now);
    this.reportLimit = new WindowLimiter(REPORTS_PER_HOUR, 3600_000, this.now);
    this.searchLimit = new WindowLimiter(FRIEND_SEARCHES_PER_MINUTE, 60_000, this.now);
    this.db.function('vj_fold', { deterministic: true }, (v) =>
      typeof v === 'string' ? fold(v) : v,
    );
    this.unsubscribe = deps.presence?.onStatusChange((c) => this.pushStatuses(c)) ?? null;
  }

  dispose(): void {
    this.unsubscribe?.();
  }

  static ref(x: string, y: string): string {
    const [a, b] = pair(x, y);
    return createHash('sha256').update(`vj-friend:${a}:${b}`).digest('base64url').slice(0, 22);
  }

  // ------------------------------------------------------------------ queries

  private isRegistered(userId: string): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM users WHERE id = ? AND kind = 'registered' AND deleted_at IS NULL")
      .get(userId);
  }

  private nameOf(userId: string): string {
    const r = this.db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId) as
      { display_name: string } | undefined;
    return r?.display_name || 'Player';
  }

  private row(x: string, y: string): FriendshipRow | null {
    const [a, b] = pair(x, y);
    return (
      (this.db.prepare('SELECT * FROM friendships WHERE user_a = ? AND user_b = ?').get(a, b) as
        FriendshipRow | undefined) ?? null
    );
  }

  /** True if either side blocks the other. */
  blockedBetween(x: string, y: string): boolean {
    return !!this.db
      .prepare(
        'SELECT 1 FROM blocks WHERE (blocker = ? AND blocked = ?) OR (blocker = ? AND blocked = ?)',
      )
      .get(x, y, y, x);
  }

  areFriends(x: string, y: string): boolean {
    return this.row(x, y)?.status === 'accepted';
  }

  /** Accepted friends' ids. */
  friendIds(me: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS id FROM friendships
           WHERE (user_a = ? OR user_b = ?) AND status = 'accepted'`,
        )
        .all(me, me, me) as { id: string }[]
    ).map((r) => r.id);
  }

  list(me: string): FriendsResponse {
    const rows = this.db
      .prepare('SELECT * FROM friendships WHERE user_a = ? OR user_b = ?')
      .all(me, me) as unknown as FriendshipRow[];
    const unread = new Map(
      (
        this.db
          .prepare(
            'SELECT sender, COUNT(*) AS n FROM messages WHERE recipient = ? AND read_at IS NULL GROUP BY sender',
          )
          .all(me) as { sender: string; n: number }[]
      ).map((r) => [r.sender, Number(r.n)]),
    );
    const out: FriendsResponse = { friends: [], incoming: [], outgoing: [], blocked: [] };
    for (const r of rows) {
      const other = r.user_a === me ? r.user_b : r.user_a;
      if (!this.isRegistered(other)) continue;
      if (r.status === 'accepted') {
        out.friends.push({
          userId: other,
          name: this.nameOf(other),
          status: this.deps.presence?.statusOf(other) ?? 'offline',
          unread: unread.get(other) ?? 0,
          since: r.accepted_at ?? r.created_at,
        });
      } else {
        const info: FriendRefInfo = {
          ref: Friends.ref(me, other),
          name: this.nameOf(other),
          at: r.created_at,
        };
        (r.requested_by === me ? out.outgoing : out.incoming).push(info);
      }
    }
    const blocks = this.db
      .prepare('SELECT blocked, created_at FROM blocks WHERE blocker = ? ORDER BY created_at DESC')
      .all(me) as { blocked: string; created_at: number }[];
    for (const b of blocks) {
      out.blocked.push({
        ref: Friends.ref(me, b.blocked),
        name: this.nameOf(b.blocked),
        at: b.created_at,
      });
    }
    const rank: Record<FriendStatus, number> = { inGame: 0, online: 1, offline: 2 };
    out.friends.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
    out.incoming.sort((a, b) => b.at - a.at);
    out.outgoing.sort((a, b) => b.at - a.at);
    return out;
  }

  // ------------------------------------------------------------------ search (v1.2 #44)

  private relation(me: string, other: string): RoomRelation {
    const r = this.row(me, other);
    if (!r) return 'none';
    if (r.status === 'accepted') return 'friend';
    return r.requested_by === me ? 'outgoing' : 'incoming';
  }

  /**
   * Prefix search on display names (case-insensitive, ≥ 3 characters, ≤ 10 results). Only
   * registered, non-deleted, discoverable users who don't block you (and whom you don't block);
   * never yourself. Results carry an opaque `ref` (no id/email) that `addByRef` accepts.
   */
  search(me: string, rawQuery: string): FriendSearchResult[] {
    const q = fold(rawQuery.trim());
    if ([...q].length < FRIEND_SEARCH_MIN)
      fail(400, 'INVALID', `type at least ${FRIEND_SEARCH_MIN} characters`);
    if (!this.searchLimit.take(me)) fail(429, 'RATE_LIMITED', 'too many searches, wait a minute');
    const rows = this.db
      .prepare(
        `SELECT id, display_name, created_at FROM users u
         WHERE kind = 'registered' AND deleted_at IS NULL AND discoverable = 1
           AND id != ? AND display_name != ''
           AND vj_fold(display_name) LIKE ? ESCAPE '\\'
           AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker = u.id AND b.blocked = ?)
                                                   OR (b.blocker = ? AND b.blocked = u.id))
         ORDER BY vj_fold(display_name), created_at
         LIMIT ?`,
      )
      .all(me, likePrefix(q), me, me, FRIEND_SEARCH_MAX_RESULTS) as {
      id: string;
      display_name: string;
      created_at: number;
    }[];
    const t = this.now();
    let refs = this.searchRefs.get(me);
    if (!refs) this.searchRefs.set(me, (refs = new Map()));
    for (const [k, v] of refs) if (v.at < t - SEARCH_REF_TTL_MS) refs.delete(k);
    const out = rows.map((r): FriendSearchResult => {
      const ref = Friends.ref(me, r.id);
      refs!.delete(ref);
      refs!.set(ref, { userId: r.id, at: t });
      return {
        ref,
        name: r.display_name,
        avatarSeed: r.display_name,
        tag: Friends.tag(ref),
        joined: new Date(r.created_at).toISOString().slice(0, 7),
        relation: this.relation(me, r.id),
      };
    });
    while (refs.size > SEARCH_REF_MAX) refs.delete(refs.keys().next().value!);
    if (this.searchRefs.size > 5000) {
      for (const [k, m] of this.searchRefs)
        if (![...m.values()].some((v) => v.at >= t - SEARCH_REF_TTL_MS)) this.searchRefs.delete(k);
    }
    return out;
  }

  /** 4 lowercase alphanumerics from a ref, shown as `#abcd` next to same-named results. */
  static tag(ref: string): string {
    const h = createHash('sha256').update(`vj-tag:${ref}`).digest();
    const A = 'abcdefghjkmnpqrstuvwxyz23456789';
    return Array.from(h.subarray(0, 4), (b) => A[b % A.length]).join('');
  }

  /** Friend request to a search result (re-checks registration, discoverability and blocks). */
  addByRef(me: string, ref: string): AddFromRoomResponse['result'] {
    const hit = this.searchRefs.get(me)?.get(ref);
    if (!hit || hit.at < this.now() - SEARCH_REF_TTL_MS) {
      return fail(404, 'INVALID', 'search again to add this player');
    }
    const ok = this.db
      .prepare(
        "SELECT 1 FROM users WHERE id = ? AND kind = 'registered' AND deleted_at IS NULL AND discoverable = 1",
      )
      .get(hit.userId);
    if (!ok || hit.userId === me) return fail(404, 'INVALID', 'that player is not available');
    return this.request(me, hit.userId);
  }

  discoverable(me: string): boolean {
    const r = this.db.prepare('SELECT discoverable FROM users WHERE id = ?').get(me) as
      { discoverable: number } | undefined;
    return r?.discoverable !== 0;
  }

  setDiscoverable(me: string, on: boolean): void {
    this.db.prepare('UPDATE users SET discoverable = ? WHERE id = ?').run(on ? 1 : 0, me);
  }

  // ------------------------------------------------------------------ rooms

  /** The caller must be a (human) player in the room; returns the room or throws. */
  private sharedRoom(me: string, code: RoomCode) {
    const room = this.deps.rooms?.get(code);
    if (!room || !room.playerIds().some((p) => room.userIdOf(p) === me)) {
      fail(404, 'ROOM_NOT_FOUND', 'you are not in that room');
    }
    return room!;
  }

  /** Relation to each other registered human in a room the caller is in (keyed by playerId). */
  roomRelations(me: string, code: RoomCode): Record<PlayerId, RoomRelation> {
    const room = this.sharedRoom(me, code);
    const out: Record<PlayerId, RoomRelation> = {};
    for (const pid of room.playerIds()) {
      const uid = room.userIdOf(pid);
      if (!uid || uid === me || !this.isRegistered(uid) || this.blockedBetween(me, uid)) continue;
      out[pid] = this.relation(me, uid);
    }
    return out;
  }

  /**
   * Friend request to a room player, resolved server-side through `room.userIdOf`; the response
   * never carries the target's account id. If they had already asked you, this accepts.
   */
  addFromRoom(me: string, code: RoomCode, playerId: PlayerId): AddFromRoomResponse['result'] {
    const room = this.sharedRoom(me, code);
    const target = room.hasPlayer(playerId) ? room.userIdOf(playerId) : null;
    if (!target || target === me || !this.isRegistered(target)) {
      fail(404, 'INVALID', 'that player has no account');
    }
    return this.request(me, target!);
  }

  /** Request (or accept a pending request from) `target`. */
  request(me: string, target: string): AddFromRoomResponse['result'] {
    if (this.blockedBetween(me, target)) fail(403, 'INVALID', "you can't add this player");
    const r = this.row(me, target);
    if (r?.status === 'accepted') return 'already';
    if (r && r.requested_by === me) return 'already';
    if (r) {
      this.accept(me, target);
      return 'accepted';
    }
    if (!this.requestLimit.take(me)) {
      fail(429, 'RATE_LIMITED', `at most ${FRIEND_REQUESTS_PER_DAY} friend requests a day`);
    }
    const [a, b] = pair(me, target);
    this.db
      .prepare(
        "INSERT INTO friendships (user_a, user_b, requested_by, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
      )
      .run(a, b, me, this.now());
    this.push(target, { t: 'friends' });
    return 'requested';
  }

  private accept(me: string, other: string): void {
    const [a, b] = pair(me, other);
    this.db
      .prepare(
        "UPDATE friendships SET status = 'accepted', accepted_at = ? WHERE user_a = ? AND user_b = ?",
      )
      .run(this.now(), a, b);
    const p = this.deps.presence;
    for (const [x, y] of [
      [me, other],
      [other, me],
    ] as const) {
      this.push(x, { t: 'friends' });
      if (p) this.push(x, { t: 'friendStatus', userId: y, status: p.statusOf(y) });
    }
  }

  /** The other user of one of `me`'s pending requests (either direction) by ref. */
  private byRequestRef(me: string, ref: string): { other: string; row: FriendshipRow } {
    const rows = this.db
      .prepare("SELECT * FROM friendships WHERE (user_a = ? OR user_b = ?) AND status = 'pending'")
      .all(me, me) as unknown as FriendshipRow[];
    for (const row of rows) {
      const other = row.user_a === me ? row.user_b : row.user_a;
      if (Friends.ref(me, other) === ref) return { other, row };
    }
    return fail(404, 'INVALID', 'no such request');
  }

  requestAction(me: string, ref: string, action: RequestActionBody['action']): void {
    const { other, row } = this.byRequestRef(me, ref);
    const incoming = row.requested_by !== me;
    switch (action) {
      case 'accept':
        if (!incoming) fail(400, 'INVALID', 'you sent that request');
        this.accept(me, other);
        return;
      case 'decline':
      case 'cancel':
        if (action === 'decline' ? !incoming : incoming) fail(400, 'INVALID', 'wrong direction');
        this.deletePair(me, other);
        if (action === 'cancel') this.push(other, { t: 'friends' });
        return;
      case 'block':
        this.block(me, other);
        return;
    }
  }

  private deletePair(x: string, y: string): void {
    const [a, b] = pair(x, y);
    this.db.prepare('DELETE FROM friendships WHERE user_a = ? AND user_b = ?').run(a, b);
  }

  private requireFriend(me: string, other: string): void {
    if (!this.areFriends(me, other) || !this.isRegistered(other)) {
      fail(404, 'INVALID', 'not your friend');
    }
  }

  remove(me: string, friend: string): void {
    this.requireFriend(me, friend);
    this.deletePair(me, friend);
    this.push(friend, { t: 'friends' });
    this.push(me, { t: 'friends' });
  }

  blockFriend(me: string, friend: string): void {
    this.requireFriend(me, friend);
    this.block(me, friend);
  }

  /** Blocks `other`: ends any friendship or request between you; DMs and invites stop. */
  private block(me: string, other: string): void {
    tx(this.db, () => {
      this.deletePair(me, other);
      this.db
        .prepare('INSERT OR IGNORE INTO blocks (blocker, blocked, created_at) VALUES (?, ?, ?)')
        .run(me, other, this.now());
    });
    this.push(other, { t: 'friends' });
    this.push(me, { t: 'friends' });
  }

  unblock(me: string, ref: string): void {
    const rows = this.db.prepare('SELECT blocked FROM blocks WHERE blocker = ?').all(me) as {
      blocked: string;
    }[];
    const hit = rows.find((r) => Friends.ref(me, r.blocked) === ref);
    if (!hit) fail(404, 'INVALID', 'no such block');
    this.db.prepare('DELETE FROM blocks WHERE blocker = ? AND blocked = ?').run(me, hit!.blocked);
    this.push(me, { t: 'friends' });
  }

  // ------------------------------------------------------------------ DMs

  messages(me: string, friend: string, before?: number): MessagesResponse {
    this.requireFriend(me, friend);
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)) AND id < ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(
        me,
        friend,
        friend,
        me,
        before ?? Number.MAX_SAFE_INTEGER,
        DM_PAGE_SIZE + 1,
      ) as unknown as MessageRow[];
    const more = rows.length > DM_PAGE_SIZE;
    const page = rows.slice(0, DM_PAGE_SIZE).reverse().map(toMessage);
    if (!before) this.markRead(me, friend);
    return { messages: page, more };
  }

  markRead(me: string, friend: string): number {
    const r = this.db
      .prepare(
        'UPDATE messages SET read_at = ? WHERE recipient = ? AND sender = ? AND read_at IS NULL',
      )
      .run(this.now(), me, friend);
    return Number(r.changes);
  }

  sendDm(me: string, friend: string, raw: string): DirectMessage {
    this.requireFriend(me, friend);
    if (this.blockedBetween(me, friend)) fail(403, 'INVALID', "you can't message this player");
    const body = sanitizeDmBody(raw);
    if (!body || body.length > DM_MAX_LENGTH) {
      fail(400, 'INVALID', `message must be 1–${DM_MAX_LENGTH} characters`);
    }
    if (!this.dmLimit.take(me)) fail(429, 'RATE_LIMITED', 'slow down a little');
    const t = this.now();
    const r = this.db
      .prepare('INSERT INTO messages (sender, recipient, body, created_at) VALUES (?, ?, ?, ?)')
      .run(me, friend, body, t);
    const message: DirectMessage = {
      id: Number(r.lastInsertRowid),
      from: me,
      to: friend,
      body,
      at: t,
      readAt: null,
    };
    this.push(friend, { t: 'dm', message });
    this.push(me, { t: 'dm', message });
    return message;
  }

  // ------------------------------------------------------------------ invites

  /** Invite a friend to the private lobby you host (`code`). */
  invite(me: string, friend: string, code: RoomCode): void {
    this.requireFriend(me, friend);
    if (this.blockedBetween(me, friend)) fail(403, 'INVALID', "you can't invite this player");
    const room = this.deps.rooms?.get(code);
    if (!room) fail(404, 'ROOM_NOT_FOUND', 'room not found');
    const kind = (room as unknown as { kind?: string }).kind;
    if (room!.userIdOf(room!.host) !== me || (kind !== undefined && kind !== 'private')) {
      fail(403, 'NOT_HOST', 'only the host of a private room can invite');
    }
    if (room!.currentPhase !== 'LOBBY') fail(409, 'BAD_PHASE', 'invites only work in the lobby');
    if (!this.inviteLimit.take(me)) fail(429, 'RATE_LIMITED', 'too many invites, wait a minute');
    const n = this.push(friend, { t: 'invite', from: me, fromName: this.nameOf(me), code });
    if (n === 0) fail(409, 'INVALID', 'your friend is offline');
  }

  // ------------------------------------------------------------------ reports

  /** Files a moderation report about a friend (optionally quoting one DM they sent you). */
  report(me: string, other: string, reason: string, messageId?: number): void {
    const known =
      this.areFriends(me, other) ||
      !!this.db
        .prepare('SELECT 1 FROM messages WHERE sender = ? AND recipient = ? LIMIT 1')
        .get(other, me);
    if (!known) fail(404, 'INVALID', 'nothing to report');
    if (!this.reportLimit.take(me)) fail(429, 'RATE_LIMITED', 'too many reports');
    let text = `dm: ${reason}`;
    if (messageId) {
      const m = this.db
        .prepare('SELECT * FROM messages WHERE id = ? AND sender = ? AND recipient = ?')
        .get(messageId, other, me) as MessageRow | undefined;
      if (m) text += `\n[message ${m.id} at ${new Date(m.created_at).toISOString()}] ${m.body}`;
    }
    this.db
      .prepare(
        `INSERT INTO reports (created_at, context, reporter_user_id, reporter_name, reported_user_id,
           reported_name, reason) VALUES (?, 'dm', ?, ?, ?, ?, ?)`,
      )
      .run(this.now(), me, this.nameOf(me), other, this.nameOf(other), text);
  }

  // ------------------------------------------------------------------ presence

  private push(userId: string, msg: Parameters<Presence['sendToUser']>[1]): number {
    return this.deps.presence?.sendToUser(userId, msg) ?? 0;
  }

  /** Presence status diff → `friendStatus` to each changed user's online friends. */
  private pushStatuses(changes: Map<string, FriendStatus>): void {
    const p = this.deps.presence;
    if (!p) return;
    try {
      for (const [uid, status] of changes) {
        for (const f of this.friendIds(uid)) {
          if (p.statusOf(f) !== 'offline')
            p.sendToUser(f, { t: 'friendStatus', userId: uid, status });
        }
      }
    } catch {
      // DB closed during shutdown; statuses are best effort.
    }
  }
}
