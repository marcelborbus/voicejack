import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PROTOCOL_VERSION, type MeResponse, type S2C } from '@dub/shared';
import { buildApp } from '../src/http/app.js';
import { ClipLibrary } from '../src/clips/ClipLibrary.js';
import { openDb, type Db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { Accounts, hashToken, SESSION_TTL_MS } from '../src/accounts/Accounts.js';
import { readCookie, SESSION_COOKIE } from '../src/accounts/cookies.js';
import { GuestLimiter } from '../src/accounts/GuestLimiter.js';
import { startServer, type RunningServer } from '../src/bootstrap.js';
import { makeClipsDir, testConfig } from './helpers.js';
import { TestSocket } from './wsClient.js';

const DAY = 24 * 3600_000;

function setCookie(res: { headers: Record<string, unknown> }): string | null {
  const h = res.headers['set-cookie'];
  const v = Array.isArray(h) ? h[0] : h;
  return typeof v === 'string' ? v : null;
}
function token(res: { headers: Record<string, unknown> }): string {
  return readCookie(setCookie(res)!.split(';')[0], SESSION_COOKIE)!;
}

describe('GET /api/me', () => {
  let app: FastifyInstance;
  let db: Db;
  let now = Date.UTC(2026, 9, 1);
  let accounts: Accounts;

  beforeAll(async () => {
    db = openDb(':memory:');
    migrate(db);
    accounts = new Accounts(db, () => now);
    app = await buildApp({
      config: testConfig({ cookieSecure: true }),
      clips: ClipLibrary.load(makeClipsDir(1)),
      accounts,
      guestLimiter: new GuestLimiter({ perIp: 3, global: 100, windowMs: 60_000 }, () => now),
    });
  });
  afterAll(async () => {
    await app.close();
    db.close();
  });

  it('creates a guest and sets a 30-day HttpOnly session cookie (hash stored only)', async () => {
    const r = await app.inject('/api/me');
    expect(r.statusCode).toBe(200);
    const body = r.json<MeResponse>();
    expect(body.user).toMatchObject({
      kind: 'guest',
      displayName: null,
      elo: 1000,
      publicGamesPlayed: 0,
    });
    expect(Object.keys(body.user).sort()).toEqual(
      ['displayName', 'elo', 'id', 'kind', 'publicGamesPlayed'].sort(),
    );
    const c = setCookie(r)!;
    expect(c).toMatch(/^vj_session=[\w-]{43};/);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Secure');
    expect(c).toContain('Path=/');
    expect(c).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    expect(r.headers['cache-control']).toBe('no-store');
    const t = token(r);
    const rows = db.prepare('SELECT * FROM sessions WHERE user_id = ?').all(body.user.id) as {
      id: string;
      expires_at: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(hashToken(t));
    expect(rows[0]!.id).not.toContain(t);
    expect(rows[0]!.expires_at).toBe(now + SESSION_TTL_MS);
  });

  it('reuses the session for a returning browser', async () => {
    const r1 = await app.inject('/api/me');
    const t = token(r1);
    const id = r1.json<MeResponse>().user.id;
    now += DAY;
    const r2 = await app.inject({
      url: '/api/me',
      headers: { cookie: `other=1; vj_session=${t}` },
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json<MeResponse>().user.id).toBe(id);
    expect(setCookie(r2)).toBeNull(); // plenty of time left, no refresh
    // last_seen_at is touched (hourly at most).
    expect(accounts.getUser(id)!.lastSeenAt).toBe(now);
    // Close to expiry, the session is extended and the cookie re-sent.
    now += 20 * DAY;
    const r3 = await app.inject({ url: '/api/me', headers: { cookie: `vj_session=${t}` } });
    expect(r3.json<MeResponse>().user.id).toBe(id);
    expect(token(r3)).toBe(t);
    expect(accounts.session(t)!.expiresAt).toBe(now + SESSION_TTL_MS);
  });

  it('expired or unknown session → a new guest', async () => {
    const r1 = await app.inject('/api/me');
    const t = token(r1);
    const id = r1.json<MeResponse>().user.id;
    now += SESSION_TTL_MS + 1;
    const r2 = await app.inject({ url: '/api/me', headers: { cookie: `vj_session=${t}` } });
    expect(r2.statusCode).toBe(200);
    expect(r2.json<MeResponse>().user.id).not.toBe(id);
    expect(token(r2)).not.toBe(t);
    const r3 = await app.inject({ url: '/api/me', headers: { cookie: 'vj_session=bogus' } });
    expect(r3.json<MeResponse>().user.id).not.toBe(id);
    // Cleanup purges the expired session.
    expect(accounts.cleanup().sessions).toBeGreaterThanOrEqual(1);
    expect(accounts.session(t)).toBeNull();
  });

  it('rate limits guest creation per IP, but not returning guests', async () => {
    now += 10 * 60_000; // fresh limiter window
    const ok = [];
    for (let i = 0; i < 3; i++) ok.push(await app.inject('/api/me'));
    expect(ok.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    const blocked = await app.inject('/api/me');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: 'RATE_LIMITED' });
    const back = await app.inject({
      url: '/api/me',
      headers: { cookie: `vj_session=${token(ok[0]!)}` },
    });
    expect(back.statusCode).toBe(200);
  });

  it('cleanup deletes long-idle guests', () => {
    const g = accounts.createGuest();
    now += 181 * DAY;
    expect(accounts.cleanup().guests).toBeGreaterThanOrEqual(1);
    expect(accounts.getUser(g.id)).toBeNull();
  });
});

describe('room join links the cookie user', () => {
  let srv: RunningServer;
  let wsUrl: string;
  const sockets: TestSocket[] = [];

  beforeAll(async () => {
    srv = await startServer(testConfig({ clipsDir: makeClipsDir(3) }));
    wsUrl = srv.url.replace('http', 'ws') + '/ws';
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await srv.close();
  });

  async function hello(m: Record<string, unknown>, cookie?: string) {
    const s = new TestSocket(wsUrl, cookie ? { cookie } : {});
    sockets.push(s);
    await s.opened;
    s.send({ t: 'hello', v: PROTOCOL_VERSION, ...m });
    const w = await s.wait<Extract<S2C, { t: 'welcome' }>>((x) => x.t === 'welcome');
    return { s, w };
  }

  it('host (token hello) and guest (name hello) get their userId; others stay unlinked', async () => {
    const me1 = await srv.app.inject('/api/me');
    const me2 = await srv.app.inject('/api/me');
    const [u1, u2] = [me1.json<MeResponse>().user.id, me2.json<MeResponse>().user.id];
    const created = (
      await srv.app.inject({ method: 'POST', url: '/api/rooms', payload: { name: 'Hosty' } })
    ).json<{ code: string; token: string; playerId: string }>();
    const room = srv.rooms.get(created.code)!;

    const host = await hello(
      { code: created.code, token: created.token },
      `vj_session=${token(me1)}`,
    );
    expect(room.userIdOf(host.w.playerId)).toBe(u1);
    const guest = await hello({ code: created.code, name: '  Gusty ' }, `vj_session=${token(me2)}`);
    expect(room.userIdOf(guest.w.playerId)).toBe(u2);
    const anon = await hello({ code: created.code, name: 'Anon' });
    expect(room.userIdOf(anon.w.playerId)).toBeNull();
    const bogus = await hello({ code: created.code, name: 'Bogus' }, 'vj_session=nope');
    expect(room.userIdOf(bogus.w.playerId)).toBeNull();

    // Names are remembered on the profile for next visit.
    expect(srv.accounts.getUser(u1)!.displayName).toBe('Hosty');
    expect(srv.accounts.getUser(u2)!.displayName).toBe('Gusty');
    const again = await srv.app.inject({
      url: '/api/me',
      headers: { cookie: `vj_session=${token(me2)}` },
    });
    expect(again.json<MeResponse>().user.displayName).toBe('Gusty');

    // userId never reaches any client.
    await anon.s.state((st) => st.players.length === 4);
    for (const x of [host, guest, anon, bogus]) {
      const raw = JSON.stringify(x.s.received);
      expect(raw).not.toContain(u1);
      expect(raw).not.toContain(u2);
    }
  });
});
