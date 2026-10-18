import { z } from 'zod';

// V15 privacy-friendly product analytics + feedback (#39). First-party, cookieless, aggregate:
// the server only keeps daily counters `(day, event, dims, count)` and anonymous feedback rows.
// No IPs, user agents, user/player ids or room codes are ever stored (see Datenschutz).

/** `POST /api/t`: the only client-side analytics endpoint. */
export const TRACK_PATH = '/api/t';

/** Route *names* a page view may report (never the URL: `/r/ABC123` is just `room`). */
export const TRACK_ROUTES = [
  'home',
  'room',
  'admin',
  'library',
  'impressum',
  'datenschutz',
  'takedown',
  'not_found',
] as const;
export type TrackRoute = (typeof TRACK_ROUTES)[number];

/** Where a client error was caught. */
export const ERROR_SOURCES = ['error', 'rejection', 'react'] as const;
export type ErrorSource = (typeof ERROR_SOURCES)[number];

/** Short hex hash of a normalized error message (the message itself never leaves the browser). */
export const ErrorHashSchema = z.string().regex(/^[0-9a-f]{8}$/);

export const FEEDBACK_COMMENT_MAX = 200;
/** 1 = 😍, 2 = 🙂, 3 = 😐, 4 = 😕 */
export const FEEDBACK_MOODS = [1, 2, 3, 4] as const;
export const MOOD_EMOJI: Record<number, string> = { 1: '😍', 2: '🙂', 3: '😐', 4: '😕' };

const PhaseSchema = z.enum(['LOBBY', 'DUBBING', 'SHOWCASE', 'ROUND_RESULTS', 'FINAL']);

export const FeedbackContextSchema = z.object({
  phase: PhaseSchema.optional(),
  route: z.enum(TRACK_ROUTES),
  version: z
    .string()
    .regex(/^[\w.+-]{1,32}$/)
    .optional(),
  errors: z.array(ErrorHashSchema).max(10).default([]),
});
export type FeedbackContext = z.infer<typeof FeedbackContextSchema>;

export const TrackPageViewSchema = z.object({
  e: z.literal('page_view'),
  route: z.enum(TRACK_ROUTES),
});
export const TrackClientErrorSchema = z.object({
  e: z.literal('client_error'),
  hash: ErrorHashSchema,
  where: z.enum(ERROR_SOURCES),
  route: z.enum(TRACK_ROUTES),
  /** Occurrences batched since the last report (the client sends each hash at most once a minute). */
  n: z.number().int().min(1).max(50).default(1),
});
export const TrackFeedbackSchema = z
  .object({
    e: z.literal('feedback'),
    kind: z.enum(['mood', 'bug']),
    mood: z.number().int().min(1).max(4).optional(),
    comment: z
      .string()
      .max(FEEDBACK_COMMENT_MAX * 2)
      .optional(),
    context: FeedbackContextSchema,
  })
  .refine((f) => (f.kind === 'mood' ? f.mood !== undefined : !!f.comment?.trim()), {
    message: 'mood feedback needs a mood, a bug report needs a description',
  });

/** Known client events. Anything else posted to `/api/t` is ignored (204, nothing stored). */
export const TrackBodySchema = z.union([
  TrackPageViewSchema,
  TrackClientErrorSchema,
  TrackFeedbackSchema,
]);
export type TrackBody = z.infer<typeof TrackBodySchema>;
export const CLIENT_EVENTS = ['page_view', 'client_error', 'feedback'] as const;

// ---------------------------------------------------------------- admin

export const analyticsPaths = {
  admin: (q?: { from?: string; to?: string; page?: number; status?: FeedbackStatus }) => {
    const qs = Object.entries(q ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
    return `/api/admin/analytics${qs ? `?${qs}` : ''}`;
  },
  feedbackResolve: (id: number) => `/api/admin/feedback/${id}/resolve`,
  feedback: (id: number) => `/api/admin/feedback/${id}`,
} as const;
export const analyticsRoutes = {
  admin: '/api/admin/analytics',
  feedbackResolve: '/api/admin/feedback/:id/resolve',
  feedback: '/api/admin/feedback/:id',
} as const;

export const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
export type FeedbackStatus = 'open' | 'resolved' | 'all';
export const FEEDBACK_PAGE_SIZE = 20;

export const AnalyticsQuerySchema = z.object({
  from: z.string().regex(DAY_REGEX).optional(),
  to: z.string().regex(DAY_REGEX).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  status: z.enum(['open', 'resolved', 'all']).default('open'),
});

export interface FeedbackItem {
  id: number;
  createdAt: number;
  kind: 'mood' | 'bug';
  mood: number | null;
  comment: string;
  context: FeedbackContext;
  resolvedAt: number | null;
}

export interface CountRow {
  key: string;
  count: number;
}

export type FunnelStep = 'visit' | 'room' | 'started' | 'finished' | 'again';

export interface CohortRow {
  /** Monday (UTC) of the sign-up week, YYYY-MM-DD. */
  week: string;
  /** Profiles (guest or registered) created that week. */
  size: number;
  /** [k] = profiles last seen in week k or later (k = 0 … weeks since). */
  active: number[];
  /** [k] = profiles that played a recorded (public) game in week k. */
  played: number[];
}

export interface ClipStat {
  clipId: string;
  title: string | null;
  /** Times the clip was dealt to a human player. */
  picks: number;
  /** Of those, how many ended with a non-empty dub. */
  dubbed: number;
  completion: number | null;
  votes: number;
  avgScore: number | null;
}

export interface ErrorStat {
  hash: string;
  where: string;
  route: string;
  count: number;
  lastDay: string;
}

export interface DailyPoint {
  day: string;
  /** Page views. */
  visits: number;
  /**
   * v1.2 #45: distinct visitors (session cookies) with a page view that day, counted via
   * in-memory daily-salted hashes; only the number is stored. An upper bound if the server
   * restarted that day (people seen on both sides of the restart count twice).
   */
  uniqueVisitors: number;
  games: number;
  /** v1.2 #45: distinct users who started a game that day (same method; bots never count). */
  uniquePlayers: number;
  feedback: number;
}

export interface AdminAnalyticsResponse {
  from: string;
  to: string;
  /** Distinct profiles (users.last_seen_at) in the last 1 / 7 / 30 days before now. */
  active: { dau: number; wau: number; mau: number };
  daily: DailyPoint[];
  funnel: { step: FunnelStep; count: number }[];
  cohorts: CohortRow[];
  clips: ClipStat[];
  dropoff: CountRow[];
  errors: ErrorStat[];
  totals: {
    gamesStarted: number;
    gamesFinished: number;
    rounds: number;
    votes: number;
    avgVote: number | null;
    avgPlayers: number | null;
    signups: number;
    publicSeats: number;
    voiceOptIns: number;
  };
  /** Per-event breakdowns by one dimension (browser, device, takes, queue wait, …). */
  breakdowns: Record<string, CountRow[]>;
  feedback: {
    items: FeedbackItem[];
    total: number;
    page: number;
    pageSize: number;
    status: FeedbackStatus;
    moods: CountRow[];
  };
}
