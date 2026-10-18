import {
  FEEDBACK_COMMENT_MAX,
  FEEDBACK_PAGE_SIZE,
  FeedbackContextSchema,
  type FeedbackContext,
  type FeedbackItem,
  type FeedbackStatus,
} from '@dub/shared';
import type { Db } from '../db/index.js';
import { buildReport, type ReportQuery } from './report.js';
import { utcDay } from './time.js';

/**
 * V15 product analytics (#39): first-party, cookieless, aggregate only.
 *
 * `track(event, dims, by)` bumps an in-memory counter keyed by (UTC day, event, dims); `flush()`
 * upserts the buffer into `analytics_daily` (every 60 s and on shutdown). Events and their
 * dimension keys are allow-listed below, and dimension values are short tokens, so no
 * identifier (user, player, room, IP, user agent) can end up in a row. Clip ids are content,
 * not people, and are allowed.
 */

/** Allowed events → allowed dimension keys. Anything else is dropped by `track`. */
export const EVENT_DIMS = {
  // client (`POST /api/t`)
  page_view: ['route', 'browser', 'device'],
  client_error: ['hash', 'where', 'route'],
  feedback: ['kind', 'mood'],
  // rooms + games (server-side; bots never count)
  room_created: ['kind'],
  room_seat: ['kind'],
  game_started: ['kind', 'players', 'bots'],
  game_seat: ['kind'],
  replay_seat: ['kind'],
  game_finished: ['kind', 'rounds', 'players'],
  finish_seat: ['kind'],
  round_played: ['kind'],
  dropoff: ['kind', 'phase'],
  submission: ['takes', 'rerecords'],
  vote: ['score'],
  clip_dealt: ['clip'],
  clip_dubbed: ['clip'],
  clip_votes: ['clip'],
  clip_vote_sum: ['clip'],
  voice_opt_in: [],
  signup: [],
  queue_wait: ['mode', 'wait'],
} as const satisfies Record<string, readonly string[]>;

export type AnalyticsEvent = keyof typeof EVENT_DIMS;
export type Dims = Record<string, string | number | boolean | null | undefined>;

/** What instrumented code depends on (rooms, matchmaker, routes). */
export interface Tracker {
  track(event: AnalyticsEvent, dims?: Dims, by?: number): void;
}

export const noopTracker: Tracker = { track: () => {} };

export const FLUSH_MS = 60_000;
export const AGGREGATE_RETENTION_DAYS = 730;
export const FEEDBACK_RETENTION_DAYS = 365;
const DAY_MS = 24 * 3600_000;
/** Dimension values: short tokens only (no spaces, no free text). */
const VALUE_RE = /^[\w.:-]{1,64}$/;
/** Safety valve: never buffer more distinct keys than this between flushes. */
const MAX_BUFFER_KEYS = 20_000;

export { utcDay };

/** Canonical dims JSON: allow-listed keys, sorted, values as strings; null if a value is bad. */
export function canonicalDims(event: AnalyticsEvent, dims: Dims = {}): string | null {
  const allowed: readonly string[] = EVENT_DIMS[event];
  const out: Record<string, string> = {};
  for (const key of [...allowed].sort()) {
    const v = dims[key];
    if (v === undefined || v === null) continue;
    const s = typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);
    if (!VALUE_RE.test(s)) return null;
    out[key] = s;
  }
  return JSON.stringify(out);
}

/** Bucketed small counts: 0, 1, 2, 3-5, 6+. */
export function countBucket(n: number): string {
  if (n <= 2) return String(Math.max(0, n));
  return n <= 5 ? '3-5' : '6+';
}

/** Queue wait histogram buckets. */
export function waitBucket(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return '<10s';
  if (s < 30) return '10-30s';
  if (s < 60) return '30-60s';
  if (s < 120) return '1-2m';
  return '2m+';
}

/**
 * Coarse browser family + device class from a User-Agent. The UA string itself is never stored
 * or logged; only these two words are kept.
 */
export function uaInfo(ua: string | undefined): { browser: string; device: string } {
  const s = ua ?? '';
  let browser = 'other';
  if (/Edg\//.test(s)) browser = 'edge';
  else if (/OPR\/|Opera/.test(s)) browser = 'opera';
  else if (/SamsungBrowser/.test(s)) browser = 'samsung';
  else if (/Firefox\/|FxiOS/.test(s)) browser = 'firefox';
  else if (/Chrome\/|CriOS|Chromium/.test(s)) browser = 'chrome';
  else if (/Safari\//.test(s)) browser = 'safari';
  let device = 'desktop';
  if (/bot|crawl|spider|headless/i.test(s)) device = 'bot';
  else if (/iPad|Tablet/.test(s) || (/Android/.test(s) && !/Mobile/.test(s))) device = 'tablet';
  else if (/Mobi|iPhone|Android/.test(s)) device = 'mobile';
  return { browser, device };
}

/** Feedback text: control / bidi characters removed, whitespace collapsed, ≤ 200 chars. */
export function sanitizeComment(raw: string | undefined): string {
  return (raw ?? '')
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, FEEDBACK_COMMENT_MAX);
}

interface FeedbackRow {
  id: number;
  created_at: number;
  kind: 'mood' | 'bug';
  mood: number | null;
  comment: string;
  context_json: string;
  resolved_at: number | null;
}

function toItem(r: FeedbackRow): FeedbackItem {
  let context: FeedbackContext = { route: 'home', errors: [] };
  try {
    const p = FeedbackContextSchema.safeParse(JSON.parse(r.context_json));
    if (p.success) context = p.data;
  } catch {
    /* keep default */
  }
  return {
    id: r.id,
    createdAt: r.created_at,
    kind: r.kind,
    mood: r.mood,
    comment: r.comment,
    context,
    resolvedAt: r.resolved_at,
  };
}

export class Analytics implements Tracker {
  private buffer = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  track(event: AnalyticsEvent, dims: Dims = {}, by = 1): void {
    if (!Object.hasOwn(EVENT_DIMS, event)) return;
    if (!Number.isFinite(by) || by <= 0) return;
    const d = canonicalDims(event, dims);
    if (d === null) return;
    const key = `${utcDay(this.now())}\u0000${event}\u0000${d}`;
    if (!this.buffer.has(key) && this.buffer.size >= MAX_BUFFER_KEYS) return;
    this.buffer.set(key, (this.buffer.get(key) ?? 0) + Math.round(by));
  }

  /** Writes the buffer into `analytics_daily` (one transaction). Returns the rows touched. */
  flush(): number {
    if (this.buffer.size === 0) return 0;
    const entries = [...this.buffer];
    this.buffer = new Map();
    const up = this.db.prepare(
      `INSERT INTO analytics_daily (day, event, dims_json, count) VALUES (?, ?, ?, ?)
       ON CONFLICT (day, event, dims_json) DO UPDATE SET count = count + excluded.count`,
    );
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [key, n] of entries) {
        const [day, event, dims] = key.split('\u0000') as [string, string, string];
        up.run(day, event, dims, n);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      // Put the counts back so the next flush retries them.
      for (const [key, n] of entries) this.buffer.set(key, (this.buffer.get(key) ?? 0) + n);
      throw e;
    }
    return entries.length;
  }

  /** Flush every `ms` (60 s). */
  start(ms = FLUSH_MS, onError?: (e: unknown) => void): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.flush();
      } catch (e) {
        onError?.(e);
      }
    }, ms);
    this.timer.unref?.();
  }

  /** Stops the timer and flushes what is left (shutdown). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }

  /** Retention: aggregates 2 years, feedback 1 year. Runs in the hourly DB cleanup. */
  prune(): { aggregates: number; feedback: number } {
    const t = this.now();
    const a = this.db
      .prepare('DELETE FROM analytics_daily WHERE day < ?')
      .run(utcDay(t - AGGREGATE_RETENTION_DAYS * DAY_MS));
    const f = this.db
      .prepare('DELETE FROM feedback WHERE created_at < ?')
      .run(t - FEEDBACK_RETENTION_DAYS * DAY_MS);
    return { aggregates: Number(a.changes), feedback: Number(f.changes) };
  }

  // ---------------------------------------------------------------- feedback

  /** Stores anonymous feedback (no user link). Returns its id. */
  addFeedback(f: {
    kind: 'mood' | 'bug';
    mood?: number;
    comment?: string;
    context: FeedbackContext;
  }): number {
    const mood = f.kind === 'mood' && f.mood && f.mood >= 1 && f.mood <= 4 ? f.mood : null;
    const ctx = FeedbackContextSchema.parse(f.context);
    const r = this.db
      .prepare(
        'INSERT INTO feedback (created_at, kind, mood, comment, context_json) VALUES (?, ?, ?, ?, ?)',
      )
      .run(this.now(), f.kind, mood, sanitizeComment(f.comment), JSON.stringify(ctx));
    this.track('feedback', { kind: f.kind, mood: mood ?? undefined });
    return Number(r.lastInsertRowid);
  }

  listFeedback(opts: {
    from: number;
    to: number;
    page?: number;
    status?: FeedbackStatus;
    pageSize?: number;
  }): { items: FeedbackItem[]; total: number } {
    const size = opts.pageSize ?? FEEDBACK_PAGE_SIZE;
    const page = Math.max(1, opts.page ?? 1);
    const status = opts.status ?? 'open';
    const where =
      'created_at >= ? AND created_at < ?' +
      (status === 'open'
        ? ' AND resolved_at IS NULL'
        : status === 'resolved'
          ? ' AND resolved_at IS NOT NULL'
          : '');
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM feedback WHERE ${where}`)
        .get(opts.from, opts.to) as {
        n: number;
      }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT * FROM feedback WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(opts.from, opts.to, size, (page - 1) * size) as unknown as FeedbackRow[];
    return { items: rows.map(toItem), total: Number(total) };
  }

  resolveFeedback(id: number, resolved = true): boolean {
    const r = this.db
      .prepare('UPDATE feedback SET resolved_at = ? WHERE id = ?')
      .run(resolved ? this.now() : null, id);
    return Number(r.changes) > 0;
  }

  /** The admin dashboard data (flushes first so it includes the last minute). */
  report(q: ReportQuery) {
    this.flush();
    return buildReport(this.db, this, q, this.now());
  }

  deleteFeedback(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM feedback WHERE id = ?').run(id).changes) > 0;
  }
}
