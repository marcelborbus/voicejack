import {
  ELO_START,
  rankedUnlocked,
  RANKED_MIN_GAMES,
  type PlayerId,
  type PresenceS2C,
  type QueueMode,
  type RoomCode,
} from '@dub/shared';
import type { Timings } from '../config.js';
import type { Presence } from '../presence/Presence.js';
import { Room } from '../room/Room.js';
import type { RoomManager } from '../room/RoomManager.js';
import { realScheduler } from '../room/timers.js';
import type { Clock, PlayerReport, Scheduler } from '../room/types.js';
import { Matcher, type MatcherRules } from './Matcher.js';
import { eloMatchRules, type RatedEntry } from './ranked.js';
import type { Reports } from './Reports.js';

/** A vote-kicked player cannot queue again for this long. */
export const VOTE_KICK_BLOCK_MS = 5 * 60_000;

/** A presence socket as the matchmaker sees it. */
export interface QueueClient {
  send(msg: PresenceS2C): void;
}

/** Who is asking to queue (resolved by the presence gateway). */
export interface Seeker {
  /** Account behind the cookie; null = anonymous (queued per socket). */
  userId: string | null;
  /** Stable per-socket key for anonymous players. */
  socketKey: string;
  ip: string | null;
  name: string;
  /** V09: casual (default) or ranked. */
  mode?: QueueMode;
}

/** V09: where the matchmaker reads a user's rating (implemented by `Ratings`). */
export interface RatingSource {
  ratingOf(userId: string): { elo: number; publicGamesPlayed: number } | null;
}

export interface QueuedPlayer extends RatedEntry {
  client: QueueClient;
  userId: string | null;
  ip: string | null;
  name: string;
}

export interface MatchmakerDeps {
  rooms: RoomManager;
  timings: Pick<Timings, 'matchFullWaitMs' | 'matchPairWaitMs' | 'matchTickMs'>;
  presence?: Presence;
  reports?: Reports;
  clock?: Clock;
  scheduler?: Scheduler;
  /** V09 ratings: ranked eligibility + the Elo the matcher compares. */
  ratings?: RatingSource;
  /** Rule overrides (default: V09 casual/ranked `compatible` / `score`, `ranked.ts`). */
  rules?: Partial<MatcherRules<QueuedPlayer>>;
  blockMs?: number;
  log?: { warn(obj: unknown, msg?: string): void };
}

export type JoinOutcome =
  { ok: true } | { ok: false; code: 'BLOCKED' | 'INVALID'; message: string };

/**
 * Public matchmaking (V08): the queue over `/ws/presence`, match forming on a tick, public
 * room creation, and the public-room aftermath (requeue at the front after a missed ready
 * check, vote-kick blocks, reports).
 */
export class Matchmaker {
  readonly matcher: Matcher<QueuedPlayer>;
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private readonly blockMs: number;
  private readonly clientKey = new Map<QueueClient, string>();
  /** Presence sockets still open (requeue needs a live one). */
  private readonly open = new Set<QueueClient>();
  /** `${code}:${playerId}` → the queue entry that became that player. */
  private readonly seated = new Map<string, QueuedPlayer>();
  /** `u:<userId>` / `ip:<ip>` → blocked until (epoch ms). */
  private readonly blocks = new Map<string, number>();
  private timer: unknown = null;
  private disposed = false;
  private log: MatchmakerDeps['log'];

  constructor(private readonly deps: MatchmakerDeps) {
    this.log = deps.log;
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.scheduler = deps.scheduler ?? realScheduler;
    this.blockMs = deps.blockMs ?? VOTE_KICK_BLOCK_MS;
    this.matcher = new Matcher<QueuedPlayer>({
      fullWaitMs: deps.timings.matchFullWaitMs,
      pairWaitMs: deps.timings.matchPairWaitMs,
      ...eloMatchRules<QueuedPlayer>(),
      ...deps.rules,
    });
    deps.rooms.setPublicHooks({
      onRequeue: (code, pid) => this.requeue(code, pid),
      onVoteKicked: (code, pid, uid) => this.voteKicked(code, pid, uid),
      onReport: (r) => this.report(r),
    });
  }

  get size(): number {
    return this.matcher.size;
  }

  setLog(log: MatchmakerDeps['log']): void {
    this.log = log;
  }

  /** The presence socket opened (so a later requeue can reach it). */
  connect(client: QueueClient): void {
    this.open.add(client);
  }

  /** The presence socket closed: leaves the queue. */
  disconnect(client: QueueClient): void {
    this.open.delete(client);
    this.leave(client, false);
  }

  /**
   * `queueJoin`. Re-joining while queued only updates the name (position and wait kept);
   * switching between casual and ranked restarts the wait. Ranked needs an account with
   * `RANKED_MIN_GAMES` public games.
   */
  join(client: QueueClient, s: Seeker): JoinOutcome {
    if (this.disposed) return { ok: true };
    this.open.add(client);
    const until = this.blockedUntil(s.userId, s.ip);
    if (until) {
      const min = Math.max(1, Math.ceil((until - this.clock.now()) / 60_000));
      return {
        ok: false,
        code: 'BLOCKED',
        message: `You were voted out of a public game. Try again in ${min} min.`,
      };
    }
    const mode: QueueMode = s.mode ?? 'casual';
    const rating = s.userId ? (this.deps.ratings?.ratingOf(s.userId) ?? null) : null;
    if (mode === 'ranked' && !rankedUnlocked(rating)) {
      return {
        ok: false,
        code: 'INVALID',
        message: `Ranked unlocks after ${RANKED_MIN_GAMES} public games.`,
      };
    }
    const key = s.userId ? `u:${s.userId}` : `s:${s.socketKey}`;
    const prev = this.matcher.get(key);
    if (prev && prev.client !== client) {
      // Same account from another tab: the newest tab holds the spot.
      this.clientKey.delete(prev.client);
      prev.client.send({ t: 'queueLeft' });
    }
    const oldKey = this.clientKey.get(client);
    if (oldKey && oldKey !== key) this.leave(client, false);
    const entry: QueuedPlayer = {
      key,
      joinedAt: (prev?.mode === mode ? prev.joinedAt : undefined) ?? this.clock.now(),
      mode,
      elo: rating?.elo ?? ELO_START,
      client,
      userId: s.userId,
      ip: s.ip,
      name: s.name,
    };
    this.matcher.join(entry);
    this.clientKey.set(client, key);
    this.deps.presence?.setLooking(key, true);
    this.sendStatus(entry);
    this.ensureTicking();
    return { ok: true };
  }

  /** `queueLeave` (or the socket closed). */
  leave(client: QueueClient, notify = true): void {
    const key = this.clientKey.get(client);
    if (!key) return;
    this.clientKey.delete(client);
    const e = this.matcher.get(key);
    if (e?.client === client) {
      this.matcher.leave(key);
      this.deps.presence?.setLooking(key, false);
    }
    if (notify) client.send({ t: 'queueLeft' });
  }

  /** Runs matching now (the timer calls this every `matchTickMs`). */
  tick(): void {
    if (this.disposed) return;
    const now = this.clock.now();
    // V13: never seat more players than the public library has clips (V14 start blocker).
    for (const group of this.matcher.take(now, this.deps.rooms.publicClipCount())) {
      if (!this.startMatch(group)) {
        // No room available (server full): back to the front, same order, retry next tick.
        for (const e of [...group].reverse()) this.matcher.requeueFront(e);
      }
    }
    this.pruneSeated();
    for (const e of this.matcher.entries()) this.sendStatus(e);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timer = null;
    this.deps.rooms.setPublicHooks(null);
  }

  // ---------------------------------------------------------------- internals

  private ensureTicking(): void {
    if (this.disposed || this.timer !== null || this.matcher.size === 0) return;
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      this.tick();
      this.ensureTicking();
    }, this.deps.timings.matchTickMs);
  }

  private sendStatus(e: QueuedPlayer): void {
    e.client.send({
      t: 'queue',
      position: this.matcher.position(e.key) ?? undefined,
      size: this.matcher.size,
      waitedMs: Math.max(0, this.clock.now() - e.joinedAt),
    });
  }

  private startMatch(group: QueuedPlayer[]): boolean {
    const room = this.deps.rooms.createPublic(group[0]?.mode ?? 'casual');
    if (!(room instanceof Room)) return false;
    for (const e of group) {
      const seat = room.seat(e.name, e.userId ?? undefined);
      this.clientKey.delete(e.client);
      this.deps.presence?.setLooking(e.key, false);
      if ('message' in seat) {
        e.client.send({ t: 'queueLeft' });
        continue;
      }
      this.seated.set(`${room.code}:${seat.playerId}`, e);
      e.client.send({ t: 'matchFound', code: room.code, token: seat.token });
    }
    room.beginReadyCheck();
    return true;
  }

  private requeue(code: RoomCode, playerId: PlayerId): void {
    const e = this.takeSeated(code, playerId);
    if (e && !this.disposed && this.open.has(e.client)) {
      // A newer queue entry of the same account wins over the requeue.
      if (!this.matcher.get(e.key)) {
        this.matcher.requeueFront(e);
        this.clientKey.set(e.client, e.key);
        this.deps.presence?.setLooking(e.key, true);
        this.sendStatus(e);
        this.ensureTicking();
      }
    }
    const room = this.deps.rooms.get(code);
    if (room && room.playerCount === 0) {
      this.scheduler.setTimeout(() => void this.deps.rooms.dispose(code), 0);
    }
  }

  private voteKicked(code: RoomCode, playerId: PlayerId, userId: string | null): void {
    const e = this.takeSeated(code, playerId);
    const until = this.clock.now() + this.blockMs;
    const uid = userId ?? e?.userId ?? null;
    // Accounts (guest cookies included) are blocked by id; only cookie-less players by IP,
    // so a kick never locks out a whole campus or household NAT.
    if (uid) this.blocks.set(`u:${uid}`, until);
    else if (e?.ip) this.blocks.set(`ip:${e.ip}`, until);
  }

  private report(r: PlayerReport): void {
    try {
      this.deps.reports?.add(r);
    } catch (err) {
      this.log?.warn({ err }, 'storing report failed');
    }
  }

  private blockedUntil(userId: string | null, ip: string | null): number {
    const now = this.clock.now();
    let until = 0;
    for (const k of [userId ? `u:${userId}` : null, !userId && ip ? `ip:${ip}` : null]) {
      if (!k) continue;
      const t = this.blocks.get(k);
      if (t === undefined) continue;
      if (t <= now) this.blocks.delete(k);
      else until = Math.max(until, t);
    }
    return until;
  }

  private takeSeated(code: RoomCode, playerId: PlayerId): QueuedPlayer | undefined {
    const k = `${code}:${playerId}`;
    const e = this.seated.get(k);
    this.seated.delete(k);
    return e;
  }

  /** Drops seat records of rooms that no longer exist or players who left. */
  private pruneSeated(): void {
    for (const k of this.seated.keys()) {
      const [code, pid] = k.split(':') as [string, string];
      if (!this.deps.rooms.get(code)?.hasPlayer(pid)) this.seated.delete(k);
    }
  }
}
