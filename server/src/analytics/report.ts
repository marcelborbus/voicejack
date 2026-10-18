import type {
  AdminAnalyticsResponse,
  ClipStat,
  CohortRow,
  CountRow,
  DailyPoint,
  ErrorStat,
  FeedbackStatus,
} from '@dub/shared';
import { FEEDBACK_PAGE_SIZE } from '@dub/shared';
import type { Db } from '../db/index.js';
import type { Analytics } from './Analytics.js';
import { utcDay } from './time.js';

const DAY_MS = 24 * 3600_000;
const WEEK_MS = 7 * DAY_MS;
/** Default range: the last 30 days. */
export const DEFAULT_RANGE_DAYS = 30;
export const MAX_COHORT_WEEKS = 12;

interface AggRow {
  day: string;
  event: string;
  dims_json: string;
  count: number;
}

function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/** Monday 00:00 UTC of the week containing `ms`. */
export function weekStart(ms: number): number {
  const d = new Date(ms);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return midnight - dow * DAY_MS;
}

function sorted(map: Map<string, number>): CountRow[] {
  return [...map]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** Numeric-ish keys (bucket labels) in natural order. */
function byKey(map: Map<string, number>): CountRow[] {
  return [...map]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
}

export interface ReportQuery {
  from?: string;
  to?: string;
  page?: number;
  status?: FeedbackStatus;
}

/**
 * `GET /api/admin/analytics`: everything the dashboard shows. Event counts come from
 * `analytics_daily`; DAU/WAU/MAU and weekly cohort retention are aggregated on the fly from the
 * service's own `users` (created_at / last_seen_at) and `game_players` rows, never copied.
 */
export function buildReport(
  db: Db,
  analytics: Analytics,
  q: ReportQuery,
  now: number = Date.now(),
): AdminAnalyticsResponse {
  const to = q.to ?? utcDay(now);
  let from = q.from ?? utcDay(dayStart(to) - (DEFAULT_RANGE_DAYS - 1) * DAY_MS);
  if (from > to) from = to;
  const fromMs = dayStart(from);
  const toMs = dayStart(to) + DAY_MS; // exclusive

  const rows = db
    .prepare('SELECT day, event, dims_json, count FROM analytics_daily WHERE day >= ? AND day <= ?')
    .all(from, to) as unknown as AggRow[];

  const total = new Map<string, number>();
  const by = new Map<string, Map<string, number>>(); // `${event}.${dim}` → value → count
  const daily = new Map<string, DailyPoint>();
  const clip = new Map<string, { picks: number; dubbed: number; votes: number; sum: number }>();
  const errors = new Map<string, ErrorStat>();
  const bump = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);

  for (const r of rows) {
    let dims: Record<string, string> = {};
    try {
      dims = JSON.parse(r.dims_json) as Record<string, string>;
    } catch {
      /* ignore */
    }
    bump(total, r.event, r.count);
    for (const [k, v] of Object.entries(dims)) {
      if (k === 'clip' || k === 'hash') continue;
      const key = `${r.event}.${k}`;
      if (!by.has(key)) by.set(key, new Map());
      bump(by.get(key)!, v, r.count);
    }
    const dp = daily.get(r.day) ?? { day: r.day, visits: 0, games: 0, feedback: 0 };
    if (r.event === 'page_view') dp.visits += r.count;
    if (r.event === 'game_started') dp.games += r.count;
    if (r.event === 'feedback') dp.feedback += r.count;
    daily.set(r.day, dp);

    if (dims.clip && r.event.startsWith('clip_')) {
      const c = clip.get(dims.clip) ?? { picks: 0, dubbed: 0, votes: 0, sum: 0 };
      if (r.event === 'clip_dealt') c.picks += r.count;
      else if (r.event === 'clip_dubbed') c.dubbed += r.count;
      else if (r.event === 'clip_votes') c.votes += r.count;
      else if (r.event === 'clip_vote_sum') c.sum += r.count;
      clip.set(dims.clip, c);
    }
    if (r.event === 'client_error' && dims.hash) {
      const k = `${dims.hash}|${dims.where ?? ''}|${dims.route ?? ''}`;
      const e = errors.get(k) ?? {
        hash: dims.hash,
        where: dims.where ?? '',
        route: dims.route ?? '',
        count: 0,
        lastDay: r.day,
      };
      e.count += r.count;
      if (r.day > e.lastDay) e.lastDay = r.day;
      errors.set(k, e);
    }
  }

  // Every day of the range, zeros included (the chart needs a continuous axis).
  const days: DailyPoint[] = [];
  for (let t = fromMs; t < toMs; t += DAY_MS) {
    const d = utcDay(t);
    days.push(daily.get(d) ?? { day: d, visits: 0, games: 0, feedback: 0 });
  }

  const titles = new Map(
    (
      db.prepare('SELECT id, title FROM clips').all() as unknown as { id: string; title: string }[]
    ).map((c) => [c.id, c.title]),
  );
  const clips: ClipStat[] = [...clip]
    .map(([clipId, c]) => ({
      clipId,
      title: titles.get(clipId) ?? null,
      picks: c.picks,
      dubbed: c.dubbed,
      completion: c.picks ? c.dubbed / c.picks : null,
      votes: c.votes,
      avgScore: c.votes ? c.sum / c.votes : null,
    }))
    .sort((a, b) => b.picks - a.picks || (b.avgScore ?? -1) - (a.avgScore ?? -1));

  const n = (e: string) => total.get(e) ?? 0;
  const breakdown = (key: string) => by.get(key) ?? new Map<string, number>();
  const votes = breakdown('vote.score');
  let voteSum = 0;
  for (const [s, c] of votes) voteSum += Number(s) * c;
  const players = breakdown('game_started.players');
  let playerSum = 0;
  for (const [p, c] of players) playerSum += Number(p) * c;
  const seats = breakdown('room_seat.kind');

  const { items, total: fbTotal } = analytics.listFeedback({
    from: fromMs,
    to: toMs,
    page: q.page,
    status: q.status,
  });
  const moods = db
    .prepare(
      `SELECT mood AS key, COUNT(*) AS count FROM feedback
       WHERE kind = 'mood' AND created_at >= ? AND created_at < ? GROUP BY mood ORDER BY mood`,
    )
    .all(fromMs, toMs) as unknown as { key: number; count: number }[];

  return {
    from,
    to,
    active: activeUsers(db, now),
    daily: days,
    funnel: [
      { step: 'visit', count: n('page_view') },
      { step: 'room', count: n('room_seat') },
      { step: 'started', count: n('game_seat') },
      { step: 'finished', count: n('finish_seat') },
      { step: 'again', count: n('replay_seat') },
    ],
    cohorts: cohorts(db, toMs, now),
    clips,
    dropoff: sorted(breakdown('dropoff.phase')),
    errors: [...errors.values()].sort((a, b) => b.count - a.count).slice(0, 50),
    totals: {
      gamesStarted: n('game_started'),
      gamesFinished: n('game_finished'),
      rounds: n('round_played'),
      votes: n('vote'),
      avgVote: n('vote') ? voteSum / n('vote') : null,
      avgPlayers: n('game_started') ? playerSum / n('game_started') : null,
      signups: n('signup'),
      publicSeats: seats.get('public') ?? 0,
      voiceOptIns: n('voice_opt_in'),
    },
    breakdowns: {
      browser: sorted(breakdown('page_view.browser')),
      device: sorted(breakdown('page_view.device')),
      route: sorted(breakdown('page_view.route')),
      roomKind: sorted(breakdown('room_created.kind')),
      players: byKey(players),
      rounds: byKey(breakdown('game_finished.rounds')),
      takes: byKey(breakdown('submission.takes')),
      rerecords: byKey(breakdown('submission.rerecords')),
      voteScore: byKey(votes),
      queueWait: sorted(breakdown('queue_wait.wait')),
    },
    feedback: {
      items,
      total: fbTotal,
      page: Math.max(1, q.page ?? 1),
      pageSize: FEEDBACK_PAGE_SIZE,
      status: q.status ?? 'open',
      moods: moods.map((m) => ({ key: String(m.key), count: Number(m.count) })),
    },
  };
}

/** Profiles seen in the last 1 / 7 / 30 days (`users.last_seen_at`, touched at most hourly). */
export function activeUsers(db: Db, now: number): { dau: number; wau: number; mau: number } {
  const r = db
    .prepare(
      `SELECT
         SUM(last_seen_at >= ?) AS dau,
         SUM(last_seen_at >= ?) AS wau,
         SUM(last_seen_at >= ?) AS mau
       FROM users WHERE deleted_at IS NULL`,
    )
    .get(now - DAY_MS, now - WEEK_MS, now - 30 * DAY_MS) as {
    dau: number | null;
    wau: number | null;
    mau: number | null;
  };
  return { dau: Number(r.dau ?? 0), wau: Number(r.wau ?? 0), mau: Number(r.mau ?? 0) };
}

/**
 * Weekly cohorts (up to 12 weeks ending at `toMs`): profiles grouped by the week they were
 * created. `active[k]` = last seen in week k or later (a lower bound for "came back"; only the
 * latest visit is known), `played[k]` = played a recorded game in week k (`game_players`, public
 * games). Computed with GROUP BY in SQLite; no per-user data leaves the query.
 */
export function cohorts(db: Db, toMs: number, now: number): CohortRow[] {
  const lastWeek = weekStart(Math.min(toMs - 1, now));
  const firstWeek = lastWeek - (MAX_COHORT_WEEKS - 1) * WEEK_MS;
  const sizes = db
    .prepare(
      `SELECT (created_at - ?) / ? AS w, COUNT(*) AS n,
         ((last_seen_at - ?) / ?) AS seen_w
       FROM users WHERE created_at >= ? AND created_at < ?
       GROUP BY w, seen_w`,
    )
    .all(firstWeek, WEEK_MS, firstWeek, WEEK_MS, firstWeek, lastWeek + WEEK_MS) as unknown as {
    w: number;
    n: number;
    seen_w: number;
  }[];
  const played = db
    .prepare(
      `SELECT (u.created_at - ?) / ? AS w, (g.created_at - ?) / ? AS gw,
         COUNT(DISTINCT gp.user_id) AS n
       FROM game_players gp
       JOIN users u ON u.id = gp.user_id
       JOIN games g ON g.id = gp.game_id
       WHERE u.created_at >= ? AND u.created_at < ? AND g.created_at >= ?
       GROUP BY w, gw`,
    )
    .all(
      firstWeek,
      WEEK_MS,
      firstWeek,
      WEEK_MS,
      firstWeek,
      lastWeek + WEEK_MS,
      firstWeek,
    ) as unknown as { w: number; gw: number; n: number }[];

  const out: CohortRow[] = [];
  for (let w = 0; w < MAX_COHORT_WEEKS; w++) {
    const span = MAX_COHORT_WEEKS - w; // weeks 0 … up to lastWeek
    const row: CohortRow = {
      week: utcDay(firstWeek + w * WEEK_MS),
      size: 0,
      active: new Array<number>(span).fill(0),
      played: new Array<number>(span).fill(0),
    };
    for (const s of sizes) {
      if (Math.floor(s.w) !== w) continue;
      row.size += Number(s.n);
      const seenK = Math.min(span - 1, Math.floor(s.seen_w) - w);
      for (let k = 0; k <= seenK; k++) row.active[k]! += Number(s.n);
    }
    for (const p of played) {
      if (Math.floor(p.w) !== w) continue;
      const k = Math.floor(p.gw) - w;
      if (k >= 0 && k < span) row.played[k]! += Number(p.n);
    }
    if (row.size > 0) out.push(row);
  }
  return out;
}
