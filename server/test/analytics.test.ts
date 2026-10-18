import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  LIMITS,
  TRACK_PATH,
  analyticsPaths,
  type AdminAnalyticsResponse,
  type ChunkMeta,
  type ClipInfo,
} from '@dub/shared';
import { buildApp } from '../src/http/app.js';
import { ClipLibrary } from '../src/clips/ClipLibrary.js';
import { openDb, type Db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import {
  Analytics,
  canonicalDims,
  countBucket,
  sanitizeComment,
  uaInfo,
  waitBucket,
} from '../src/analytics/Analytics.js';
import { weekStart } from '../src/analytics/report.js';
import { Room } from '../src/room/Room.js';
import { realScheduler } from '../src/room/timers.js';
import { TIMINGS_PRESETS } from '../src/config.js';
import { TRACK_RATE_LIMIT } from '../src/routes/track.js';
import { makeClipsDir, testConfig } from './helpers.js';

const DAY = 24 * 3600_000;
const T0 = Date.UTC(2026, 9, 14, 12); // Wednesday

interface AggRow {
  day: string;
  event: string;
  dims_json: string;
  count: number;
}
const rows = (db: Db) =>
  db
    .prepare('SELECT day, event, dims_json, count FROM analytics_daily ORDER BY event, dims_json')
    .all() as unknown as AggRow[];

function fresh(now: () => number = () => T0) {
  const db = openDb(':memory:');
  migrate(db);
  return { db, analytics: new Analytics(db, { now }) };
}

describe('Analytics.track (allow-list + aggregation)', () => {
  it('drops unknown events, unknown dimension keys and non-token values', () => {
    const { db, analytics } = fresh();
    analytics.track('nope' as never, {});
    analytics.track('room_created', { kind: 'private', room: 'ABCDEF', userId: 'u1' });
    analytics.track('page_view', { route: 'home', browser: 'Mozilla/5.0 (X11; Linux)' });
    analytics.track('vote', { score: 7 }, 0);
    analytics.track('vote', { score: 7 }, -3);
    analytics.flush();
    expect(rows(db)).toEqual([
      { day: '2026-10-14', event: 'room_created', dims_json: '{"kind":"private"}', count: 1 },
    ]);
  });

  it('canonicalizes dims (sorted keys, strings, booleans as yes/no)', () => {
    expect(canonicalDims('game_started', { players: 3, kind: 'public', bots: true })).toBe(
      '{"bots":"yes","kind":"public","players":"3"}',
    );
    expect(canonicalDims('signup', { anything: 'x' })).toBe('{}');
  });

  it('buffers in memory and upserts on flush (counts add up across flushes and days)', () => {
    let now = T0;
    const { db, analytics } = fresh(() => now);
    analytics.track('vote', { score: 7 });
    analytics.track('vote', { score: 7 });
    analytics.track('clip_vote_sum', { clip: 'clip-1' }, 9);
    expect(rows(db)).toEqual([]); // nothing written before the flush
    expect(analytics.flush()).toBe(2);
    analytics.track('vote', { score: 7 });
    analytics.flush();
    now += DAY;
    analytics.track('vote', { score: 7 });
    analytics.stop();
    expect(rows(db).filter((r) => r.event === 'vote')).toEqual([
      { day: '2026-10-14', event: 'vote', dims_json: '{"score":"7"}', count: 3 },
      { day: '2026-10-15', event: 'vote', dims_json: '{"score":"7"}', count: 1 },
    ]);
    expect(rows(db).find((r) => r.event === 'clip_vote_sum')?.count).toBe(9);
    expect(analytics.flush()).toBe(0);
  });

  it('prunes aggregates after 2 years and feedback after 1 year', () => {
    let now = T0;
    const { db, analytics } = fresh(() => now);
    analytics.track('signup');
    analytics.addFeedback({ kind: 'mood', mood: 1, context: { route: 'room', errors: [] } });
    analytics.flush();
    now = T0 + 364 * DAY;
    expect(analytics.prune()).toEqual({ aggregates: 0, feedback: 0 });
    now = T0 + 366 * DAY;
    expect(analytics.prune()).toEqual({ aggregates: 0, feedback: 1 });
    now = T0 + 731 * DAY;
    expect(analytics.prune()).toEqual({ aggregates: 2, feedback: 0 }); // signup + feedback counter
    expect(rows(db)).toEqual([]);
  });

  it('helpers: buckets, UA reduction, comment sanitizing', () => {
    expect([0, 1, 2, 3, 5, 6, 40].map(countBucket)).toEqual([
      '0',
      '1',
      '2',
      '3-5',
      '3-5',
      '6+',
      '6+',
    ]);
    expect([5_000, 15_000, 45_000, 90_000, 600_000].map(waitBucket)).toEqual([
      '<10s',
      '10-30s',
      '30-60s',
      '1-2m',
      '2m+',
    ]);
    expect(
      uaInfo(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      ),
    ).toEqual({ browser: 'safari', device: 'mobile' });
    expect(
      uaInfo(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0',
      ),
    ).toEqual({ browser: 'edge', device: 'desktop' });
    expect(
      uaInfo('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0'),
    ).toEqual({
      browser: 'firefox',
      device: 'desktop',
    });
    expect(uaInfo(undefined)).toEqual({ browser: 'other', device: 'desktop' });
    expect(sanitizeComment('  hi\u0000‮there\n\tyou​ ')).toBe('hi there you');
    expect(sanitizeComment('x'.repeat(500))).toHaveLength(200);
  });
});

// ------------------------------------------------------------------ room instrumentation

function clip(id: string): ClipInfo {
  return {
    id,
    title: id,
    url: `/clips/${id}.mp4`,
    durationMs: 8000,
    width: 640,
    height: 360,
    tags: [],
    attribution: { author: 'a', source: 's', license: 'CC0' },
  };
}
const chunk = (id: string, startMs: number): ChunkMeta => ({
  id,
  startMs,
  durationMs: 1000,
  offsetMs: 0,
  mime: 'audio/webm;codecs=opus',
  bytes: 500,
});

describe('Room analytics', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts a game without storing ids, room codes or bots', () => {
    const { db, analytics } = fresh(() => Date.now());
    const uploaded = new Set<string>();
    const room = new Room({
      code: 'QWERTY',
      clock: { now: () => Date.now() },
      scheduler: realScheduler,
      emit: () => {},
      clips: ['ca', 'cb', 'cc', 'cd'].map(clip),
      timings: { ...TIMINGS_PRESETS.fast },
      options: {
        allowSolo: false,
        allowShortDubbing: true,
        maxPlayers: 8,
        limits: LIMITS,
        devBots: true,
      },
      isUploaded: (s, c) => uploaded.has(`${s}/${c}`),
      analytics,
      newId: (() => {
        let i = 0;
        return () => `pid-${++i}`;
      })(),
    });
    const ids = ['Ann', 'Bob', 'Cid'].map((n) => {
      const j = room.join(n);
      if ('message' in j) throw new Error(j.message);
      room.connect(j.playerId);
      room.linkUser(j.playerId, `user-secret-${n}`);
      return j.playerId;
    });
    const [a, b, c] = ids as [string, string, string];
    expect(room.handle(a, { t: 'addBot' })).toBeNull();
    expect(
      room.handle(a, {
        t: 'updateSettings',
        settings: { mode: 'extended', rounds: 1, dubbingSeconds: 60, tags: [] },
      }),
    ).toBeNull();
    for (const id of room.playerIds()) {
      room.handle(id, { t: 'micStatus', ok: true });
      room.handle(id, { t: 'setReady', ready: true });
    }
    expect(room.handle(a, { t: 'startGame' })).toBeNull();
    const sub = (id: string) => room.snapshotFor(id)!.you.submissionId!;
    // Ann records, then re-records (k1 replaced by k2); Bob records once; Cid nothing.
    room.handle(a, { t: 'manifest', round: 0, chunks: [chunk('k1', 0)] });
    room.handle(a, { t: 'manifest', round: 0, chunks: [chunk('k2', 0)] });
    uploaded.add(`${sub(a)}/k2`);
    room.handle(b, { t: 'manifest', round: 0, chunks: [chunk('k3', 0)] });
    uploaded.add(`${sub(b)}/k3`);
    // Cid drops out mid-dubbing and never comes back.
    room.disconnect(c);
    for (const id of [a, b]) room.handle(id, { t: 'dubDone', round: 0, done: true });

    for (let i = 0; i < 200 && room.currentPhase !== 'FINAL'; i++) {
      const s = room.snapshotFor(a)!;
      if (s.phase === 'DUBBING') {
        for (const id of room.playerIds()) room.handle(id, { t: 'dubDone', round: 0, done: true });
      }
      if (s.showcase?.status === 'PLAYING') {
        for (const id of [a, b]) {
          room.handle(id, { t: 'vote', submissionId: s.showcase.submissionId, score: 8 });
        }
      }
      vi.advanceTimersByTime(250);
    }
    expect(room.currentPhase).toBe('FINAL');
    analytics.flush();

    const all = rows(db);
    const count = (event: string, dims?: string) =>
      all
        .filter((r) => r.event === event && (dims === undefined || r.dims_json === dims))
        .reduce((n, r) => n + r.count, 0);
    expect(count('room_seat')).toBe(3); // the bot is not a seat
    expect(count('game_started', '{"bots":"yes","kind":"private","players":"3"}')).toBe(1);
    expect(count('game_seat')).toBe(3);
    expect(count('game_finished', '{"kind":"private","players":"3","rounds":"1"}')).toBe(1);
    expect(count('finish_seat')).toBe(2);
    expect(count('dropoff', '{"kind":"private","phase":"DUBBING"}')).toBe(1);
    expect(count('round_played')).toBe(1);
    expect(count('submission', '{"rerecords":"1","takes":"1"}')).toBe(1); // Ann
    expect(count('submission', '{"rerecords":"0","takes":"1"}')).toBe(1); // Bob
    expect(count('submission', '{"rerecords":"0","takes":"0"}')).toBe(1); // Cid
    expect(count('clip_dealt')).toBe(3);
    expect(count('clip_dubbed')).toBe(2);
    // Ann votes on Bob's dub and vice versa (the bot's dub is empty: no sounds in this test).
    expect(count('vote', '{"score":"8"}')).toBe(2);
    expect(count('clip_votes')).toBe(2);
    expect(count('clip_vote_sum')).toBe(16);

    // Nothing identifying anywhere in the table.
    const dump = JSON.stringify(all);
    for (const secret of ['QWERTY', 'pid-', 'user-secret', 'Ann', 'Bob', 'Cid']) {
      expect(dump).not.toContain(secret);
    }
    room.dispose();
  });
});

// ------------------------------------------------------------------ HTTP

describe('POST /api/t + admin analytics', () => {
  let app: FastifyInstance;
  let db: Db;
  let analytics: Analytics;
  const now = () => T0;
  const UA =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  const IP = '203.0.113.77';

  beforeAll(async () => {
    db = openDb(':memory:');
    migrate(db);
    analytics = new Analytics(db, { now });
    app = await buildApp({
      config: testConfig({ adminDev: true, trustProxy: '127.0.0.1' }),
      clips: ClipLibrary.load(makeClipsDir(1)),
      analytics,
    });
  });
  afterAll(async () => {
    await app.close();
    db.close();
  });

  const post = (body: unknown, ip = IP) =>
    app.inject({
      method: 'POST',
      url: TRACK_PATH,
      headers: { 'user-agent': UA, 'x-forwarded-for': ip, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });

  it('accepts allow-listed events, ignores unknown ones, rejects malformed ones', async () => {
    expect((await post({ e: 'page_view', route: 'room' })).statusCode).toBe(204);
    expect((await post({ e: 'page_view', route: 'room', code: 'ABCDEF' })).statusCode).toBe(204);
    expect((await post({ e: 'evil', data: 'x' })).statusCode).toBe(204);
    expect((await post({ e: 'page_view', route: '/r/ABCDEF' })).statusCode).toBe(400);
    expect(
      (await post({ e: 'client_error', hash: 'deadbeef', where: 'error', route: 'room', n: 3 }))
        .statusCode,
    ).toBe(204);
    expect(
      (await post({ e: 'client_error', hash: 'not a hash', where: 'error', route: 'room' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post({ e: 'feedback', kind: 'mood', context: { route: 'room' } })).statusCode,
    ).toBe(400);
    analytics.flush();
    const r = rows(db);
    expect(r.filter((x) => x.event === 'page_view')).toEqual([
      {
        day: '2026-10-14',
        event: 'page_view',
        dims_json: '{"browser":"chrome","device":"desktop","route":"room"}',
        count: 2,
      },
    ]);
    expect(r.find((x) => x.event === 'client_error')?.count).toBe(3);
    expect(r.some((x) => x.event === 'evil')).toBe(false);
  });

  it('feedback round trip: stored without user link, sanitized, listed, resolved, deleted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: TRACK_PATH,
      headers: {
        'user-agent': UA,
        'x-forwarded-for': IP,
        cookie: 'vj_session=secret-session-token',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        e: 'feedback',
        kind: 'mood',
        mood: 2,
        comment: 'Fun!\u0007 <b>more clips</b>‮',
        context: { phase: 'FINAL', route: 'room', version: '1.1.0', errors: ['deadbeef'] },
      }),
    });
    expect(res.statusCode).toBe(204);
    const stored = db.prepare('SELECT * FROM feedback').all();
    expect(stored).toHaveLength(1);
    const dump = JSON.stringify(stored) + JSON.stringify(rows(db));
    for (const secret of [IP, UA, 'secret-session-token', 'Chrome/130']) {
      expect(dump).not.toContain(secret);
    }
    expect(Object.keys(stored[0]!).sort()).toEqual(
      ['comment', 'context_json', 'created_at', 'id', 'kind', 'mood', 'resolved_at'].sort(),
    );

    const get = await app.inject(analyticsPaths.admin());
    expect(get.statusCode).toBe(200);
    const body = get.json<AdminAnalyticsResponse>();
    expect(body.feedback.items).toEqual([
      {
        id: expect.any(Number),
        createdAt: T0,
        kind: 'mood',
        mood: 2,
        comment: 'Fun! <b>more clips</b>',
        context: { phase: 'FINAL', route: 'room', version: '1.1.0', errors: ['deadbeef'] },
        resolvedAt: null,
      },
    ]);
    const id = body.feedback.items[0]!.id;
    expect(body.feedback.moods).toEqual([{ key: '2', count: 1 }]);

    const bug = await post({
      e: 'feedback',
      kind: 'bug',
      comment: 'Video froze',
      context: { route: 'home', errors: [] },
    });
    expect(bug.statusCode).toBe(204);
    expect(
      (await post({ e: 'feedback', kind: 'bug', comment: '  ', context: { route: 'home' } }))
        .statusCode,
    ).toBe(400);

    const resolve = await app.inject({ method: 'POST', url: analyticsPaths.feedbackResolve(id) });
    expect(resolve.statusCode).toBe(204);
    const open = (await app.inject(analyticsPaths.admin())).json<AdminAnalyticsResponse>();
    expect(open.feedback.items.map((f) => f.kind)).toEqual(['bug']);
    const done = (
      await app.inject(analyticsPaths.admin({ status: 'resolved' }))
    ).json<AdminAnalyticsResponse>();
    expect(done.feedback.items.map((f) => f.id)).toEqual([id]);
    expect(
      (await app.inject({ method: 'DELETE', url: analyticsPaths.feedback(id) })).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: 'DELETE', url: analyticsPaths.feedback(id) })).statusCode,
    ).toBe(404);
  });

  it('admin endpoint shape', async () => {
    const res = await app.inject(analyticsPaths.admin({ from: '2026-10-01', to: '2026-10-14' }));
    expect(res.statusCode).toBe(200);
    const body = res.json<AdminAnalyticsResponse>();
    expect(Object.keys(body).sort()).toEqual(
      [
        'active',
        'breakdowns',
        'clips',
        'cohorts',
        'daily',
        'dropoff',
        'errors',
        'feedback',
        'from',
        'funnel',
        'to',
        'totals',
      ].sort(),
    );
    expect(body.from).toBe('2026-10-01');
    expect(body.daily).toHaveLength(14);
    expect(body.funnel.map((f) => f.step)).toEqual([
      'visit',
      'room',
      'started',
      'finished',
      'again',
    ]);
    expect(body.funnel[0]!.count).toBe(2);
    expect(body.errors).toEqual([
      { hash: 'deadbeef', where: 'error', route: 'room', count: 3, lastDay: '2026-10-14' },
    ]);
    expect(body.breakdowns.browser).toEqual([{ key: 'chrome', count: 2 }]);
    expect((await app.inject(analyticsPaths.admin({ from: 'yesterday' }))).statusCode).toBe(400);
  });

  it('is not reachable for non-admins', async () => {
    const res = await app.inject({
      url: analyticsPaths.admin(),
      remoteAddress: '198.51.100.1',
    });
    expect(res.statusCode).toBe(403);
  });

  it('rate-limits POST /api/t per client', async () => {
    const ip = '198.51.100.9';
    let last = 0;
    for (let i = 0; i <= TRACK_RATE_LIMIT.max; i++) {
      last = (await post({ e: 'page_view', route: 'home' }, ip)).statusCode;
    }
    expect(last).toBe(429);
    expect((await post({ e: 'page_view', route: 'home' }, '198.51.100.10')).statusCode).toBe(204);
  });
});

// ------------------------------------------------------------------ users-based metrics

describe('DAU/WAU/MAU + weekly cohorts from users / game_players', () => {
  it('aggregates the existing rows', () => {
    const { db, analytics } = fresh();
    const mon = weekStart(T0); // Monday 2026-10-12
    expect(new Date(mon).toISOString()).toBe('2026-10-12T00:00:00.000Z');
    const addUser = (id: string, created: number, seen: number) =>
      db
        .prepare('INSERT INTO users (id, kind, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
        .run(id, 'guest', created, seen);
    const W = 7 * DAY;
    // Cohort two weeks ago: 3 users; u1 still active this week, u2 came back last week, u3 never.
    addUser('u1', mon - 2 * W + DAY, T0 - 3600_000);
    addUser('u2', mon - 2 * W + 2 * DAY, mon - W + DAY);
    addUser('u3', mon - 2 * W + 3 * DAY, mon - 2 * W + 3 * DAY);
    // This week's cohort: 1 user.
    addUser('u4', mon + DAY, T0 - 2 * DAY);
    db.prepare(
      "INSERT INTO games (id, kind, room_code, created_at) VALUES ('g1', 'casual', 'AAAAAA', ?)",
    ).run(mon - W + DAY);
    db.prepare(
      "INSERT INTO game_players (game_id, user_id, place, total, elo_before, elo_after) VALUES ('g1', 'u2', 1, 10, 1000, 1010)",
    ).run();
    const r = analytics.report({});
    expect(r.active).toEqual({ dau: 1, wau: 2, mau: 4 });
    const old = r.cohorts.find((c) => c.week === '2026-09-28')!;
    expect(old.size).toBe(3);
    expect(old.active).toEqual([3, 2, 1]);
    expect(old.played).toEqual([0, 1, 0]);
    const cur = r.cohorts.find((c) => c.week === '2026-10-12')!;
    expect(cur).toEqual({ week: '2026-10-12', size: 1, active: [1], played: [0] });
    expect(JSON.stringify(r.cohorts)).not.toContain('u1');
  });
});
