/**
 * Public matchmaking queue + match forming (V08), pure: no timers, no I/O. The Matchmaker
 * service ticks it once per `matchTickMs` with the current time.
 *
 * Rules (defaults): queue order is priority order (front first; a player who missed a ready
 * check goes back to the very front and keeps their `joinedAt`). For each anchor in queue order
 * the candidates are the other queued players `compatible` with it, best `score` first, then
 * queue order. A match is formed from the anchor plus up to `maxPlayers - 1` candidates when
 *  - it is full (`maxPlayers`, 6), or
 *  - it has `minPlayers` (3) and the anchor (the longest waiting) waited `fullWaitMs` (20 s), or
 *  - it has 2 and the anchor waited `pairWaitMs` (60 s).
 *
 * V09 (Elo) plugs in through `compatible` (rating window that widens with `waitedMs`) and
 * `score` (closest rating first); both default to "everyone fits equally".
 */

export interface QueueEntry {
  /** Identity: user id, or a per-socket key for anonymous players. */
  key: string;
  /** First time this player joined the queue (epoch ms); kept across a requeue. */
  joinedAt: number;
}

export interface MatchContext<T extends QueueEntry> {
  now: number;
  /** Everyone still unmatched, in priority order. */
  queue: readonly T[];
}

export interface MatcherRules<T extends QueueEntry> {
  minPlayers: number;
  maxPlayers: number;
  fullWaitMs: number;
  pairWaitMs: number;
  /** May `b` join a match anchored on `a`, who has waited `waitedMs`? */
  compatible(a: T, b: T, waitedMs: number, ctx: MatchContext<T>): boolean;
  /** Preference among compatible candidates for anchor `a`: higher first. */
  score(a: T, b: T): number;
}

export const DEFAULT_MATCH_RULES: MatcherRules<QueueEntry> = {
  minPlayers: 3,
  maxPlayers: 6,
  fullWaitMs: 20_000,
  pairWaitMs: 60_000,
  compatible: () => true,
  score: () => 0,
};

export class Matcher<T extends QueueEntry = QueueEntry> {
  readonly rules: MatcherRules<T>;
  private queue: T[] = [];

  constructor(rules: Partial<MatcherRules<T>> = {}) {
    this.rules = { ...(DEFAULT_MATCH_RULES as MatcherRules<T>), ...rules };
    if (this.rules.minPlayers < 2 || this.rules.maxPlayers < this.rules.minPlayers) {
      throw new Error('matcher: need 2 <= minPlayers <= maxPlayers');
    }
  }

  get size(): number {
    return this.queue.length;
  }

  /** Queued entries in priority order. */
  entries(): readonly T[] {
    return this.queue;
  }

  get(key: string): T | undefined {
    return this.queue.find((e) => e.key === key);
  }

  /** Appends `entry` (or replaces the queued entry with the same key in place). */
  join(entry: T): void {
    const i = this.queue.findIndex((e) => e.key === entry.key);
    if (i >= 0) this.queue[i] = entry;
    else this.queue.push(entry);
  }

  /** Puts `entry` at the very front (missed ready check); its `joinedAt` is kept as given. */
  requeueFront(entry: T): void {
    this.leave(entry.key);
    this.queue.unshift(entry);
  }

  leave(key: string): T | undefined {
    const i = this.queue.findIndex((e) => e.key === key);
    if (i < 0) return undefined;
    return this.queue.splice(i, 1)[0];
  }

  /** 1-based queue position, or null if not queued. */
  position(key: string): number | null {
    const i = this.queue.findIndex((e) => e.key === key);
    return i < 0 ? null : i + 1;
  }

  /** Forms every match the rules allow at `now` and removes those players from the queue. */
  take(now: number): T[][] {
    const { minPlayers, maxPlayers, fullWaitMs, pairWaitMs, compatible, score } = this.rules;
    const out: T[][] = [];
    let i = 0;
    while (i < this.queue.length) {
      const a = this.queue[i]!;
      const waited = now - a.joinedAt;
      const ctx: MatchContext<T> = { now, queue: this.queue };
      const cands = this.queue
        .map((b, j) => ({ b, j }))
        .filter(({ b, j }) => j !== i && compatible(a, b, waited, ctx))
        .sort((x, y) => score(a, y.b) - score(a, x.b) || x.j - y.j)
        .slice(0, maxPlayers - 1)
        .map(({ b }) => b);
      const n = cands.length + 1;
      const go =
        n >= maxPlayers ||
        (n >= minPlayers && waited >= fullWaitMs) ||
        (n >= 2 && waited >= pairWaitMs);
      if (!go) {
        i++;
        continue;
      }
      const group = [a, ...cands];
      const taken = new Set(group);
      this.queue = this.queue.filter((e) => !taken.has(e));
      out.push(group);
      // Entries before `i` were not matchable and stay so; continue at the same index.
    }
    return out;
  }
}
