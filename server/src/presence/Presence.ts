import { PRESENCE_THROTTLE_MS, type PresenceCounts, type PresenceS2C } from '@dub/shared';
import type { RoomManager } from '../room/RoomManager.js';
import { realScheduler } from '../room/timers.js';
import type { Clock, Scheduler } from '../room/types.js';

/** One `/ws/presence` socket as seen by the service (implemented by the presence gateway). */
export interface PresenceClient {
  send(msg: PresenceS2C): void;
  close(code?: number, reason?: string): void;
}

export interface PresenceDeps {
  /** Room sockets count as online too; phases give `inGame`. */
  rooms?: RoomManager;
  clock?: Clock;
  scheduler?: Scheduler;
  throttleMs?: number;
}

/**
 * Who is online, and the counts pushed to every presence socket (V07).
 *
 * `online` counts distinct identities over presence and room sockets: a cookie user is one
 * identity however many tabs/sockets they have; an anonymous socket is one identity on its own.
 * Counts are recomputed lazily: anything that may change them calls `markDirty()`, and a
 * broadcast happens at most once per `throttleMs`, only when the numbers actually changed.
 */
export class Presence {
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private readonly throttleMs: number;
  /** Every presence socket → its cookie user (null = anonymous). */
  private readonly clients = new Map<PresenceClient, string | null>();
  /** Matchmaking queue members (V08 drives this through `setLooking`). */
  private readonly looking = new Set<string>();
  private timer: unknown = null;
  private lastFlush = Number.NEGATIVE_INFINITY;
  private lastSent: PresenceCounts | null = null;
  private readonly unsubscribe: (() => void) | null;
  private disposed = false;

  constructor(private readonly deps: PresenceDeps = {}) {
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.scheduler = deps.scheduler ?? realScheduler;
    this.throttleMs = deps.throttleMs ?? PRESENCE_THROTTLE_MS;
    this.unsubscribe = deps.rooms?.onActivity(() => this.markDirty()) ?? null;
  }

  /** Registers a presence socket and sends it the current counts. Returns its remover. */
  add(client: PresenceClient, userId: string | null): () => void {
    this.clients.set(client, userId);
    client.send({ t: 'counts', ...this.counts() });
    this.markDirty();
    return () => {
      if (this.clients.delete(client)) this.markDirty();
    };
  }

  /**
   * Marks `key` (a user id, or any stable per-socket key for anonymous players) as in the
   * matchmaking queue or not. V08 hook; nothing calls it yet, so `lookingForGame` is 0.
   */
  setLooking(key: string, looking: boolean): void {
    const had = this.looking.has(key);
    if (looking === had) return;
    if (looking) this.looking.add(key);
    else this.looking.delete(key);
    this.markDirty();
  }

  /** True if the user has any presence or room socket (V10 friend status). */
  isOnline(userId: string): boolean {
    for (const uid of this.clients.values()) if (uid === userId) return true;
    for (const c of this.deps.rooms?.humanConnections() ?? []) if (c.userId === userId) return true;
    return false;
  }

  /** Sends `msg` to every presence socket of `userId`; returns how many got it (V10 DMs/invites). */
  sendToUser(userId: string, msg: PresenceS2C): number {
    let n = 0;
    for (const [client, uid] of this.clients) {
      if (uid !== userId) continue;
      client.send(msg);
      n++;
    }
    return n;
  }

  get socketCount(): number {
    return this.clients.size;
  }

  counts(): PresenceCounts {
    const ids = new Set<string>();
    let anon = 0;
    for (const uid of this.clients.values()) {
      if (uid) ids.add(uid);
      else anon++;
    }
    let inGame = 0;
    for (const c of this.deps.rooms?.humanConnections() ?? []) {
      if (c.userId) ids.add(c.userId);
      else anon++;
      if (c.phase !== 'LOBBY') inGame++;
    }
    return { online: ids.size + anon, inGame, lookingForGame: this.looking.size };
  }

  /** Something may have changed; schedules a (throttled) recount + broadcast. */
  markDirty(): void {
    if (this.disposed || this.timer !== null) return;
    const wait = Math.max(0, this.lastFlush + this.throttleMs - this.clock.now());
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  private flush(): void {
    if (this.disposed) return;
    const c = this.counts();
    const prev = this.lastSent;
    if (
      prev &&
      prev.online === c.online &&
      prev.inGame === c.inGame &&
      prev.lookingForGame === c.lookingForGame
    ) {
      return;
    }
    this.lastSent = c;
    this.lastFlush = this.clock.now();
    const msg: PresenceS2C = { t: 'counts', ...c };
    for (const client of this.clients.keys()) client.send(msg);
  }

  /** Stops timers and closes every presence socket. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timer = null;
    for (const client of [...this.clients.keys()]) client.close(1001, 'server shutting down');
    this.clients.clear();
  }
}
