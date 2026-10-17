import net from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { MeResponse } from '@dub/shared';
import { buildApp } from '../src/http/app.js';
import { ClipLibrary } from '../src/clips/ClipLibrary.js';
import { openDb, type Db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { Accounts, LOGIN_TOKEN_TTL_MS } from '../src/accounts/Accounts.js';
import { readCookie, SESSION_COOKIE } from '../src/accounts/cookies.js';
import { GuestLimiter } from '../src/accounts/GuestLimiter.js';
import { AUTH_IP_LIMITS } from '../src/routes/auth.js';
import { LogMailer } from '../src/mail/Mailer.js';
import { buildMessage, sendSmtp } from '../src/mail/smtp.js';
import { makeClipsDir, testConfig } from './helpers.js';

const PUBLIC = 'https://vj.example';

function cookieOf(res: { headers: Record<string, unknown> }): string | null {
  const h = res.headers['set-cookie'];
  const v = Array.isArray(h) ? h[0] : h;
  if (typeof v !== 'string') return null;
  const t = readCookie(v.split(';')[0], SESSION_COOKIE);
  return t ? `${SESSION_COOKIE}=${t}` : null;
}

describe('magic-link auth (V04)', () => {
  let app: FastifyInstance;
  let db: Db;
  let accounts: Accounts;
  let mailer: LogMailer;
  let now = Date.UTC(2026, 9, 1);
  let ip = 0;

  beforeAll(async () => {
    db = openDb(':memory:');
    migrate(db);
    accounts = new Accounts(db, () => now);
    mailer = new LogMailer();
    app = await buildApp({
      config: testConfig({ publicUrl: PUBLIC, cookieSecure: false }),
      clips: ClipLibrary.load(makeClipsDir(1)),
      accounts,
      mailer,
      guestLimiter: new GuestLimiter({ perIp: 1000, global: 10_000, windowMs: 60_000 }),
      authLimiter: new GuestLimiter(AUTH_IP_LIMITS, () => now),
    });
  });
  afterAll(async () => {
    await app.close();
    db.close();
  });
  // A fresh client IP per test so the per-IP limit only bites where tested.
  beforeEach(() => {
    ip++;
    now += 3600_000;
  });
  const addr = () => `10.0.0.${ip}`;

  async function guest(): Promise<{ cookie: string; me: MeResponse['user'] }> {
    const r = await app.inject({ url: '/api/me', remoteAddress: addr() });
    return { cookie: cookieOf(r)!, me: r.json<MeResponse>().user };
  }
  async function me(cookie: string) {
    return (await app.inject({ url: '/api/me', headers: { cookie }, remoteAddress: addr() })).json<
      MeResponse
    >().user;
  }
  function request(email: string, cookie?: string, remoteAddress = addr()) {
    return app.inject({
      method: 'POST',
      url: '/api/auth/request',
      payload: { email },
      headers: cookie ? { cookie } : {},
      remoteAddress,
    });
  }
  /** Token from the last mail to `email`. */
  function lastLink(email: string): string {
    const m = [...mailer.outbox].reverse().find((x) => x.to === email);
    if (!m) throw new Error(`no mail to ${email}`);
    const link = /https:\/\/vj\.example\/api\/auth\/verify\?t=[\w%-]+/.exec(m.text)![0];
    expect(m.html).toContain(link);
    return link;
  }
  const tokenOf = (link: string) => decodeURIComponent(new URL(link).searchParams.get('t')!);
  function confirm(t: string, cookie?: string) {
    return app.inject({
      method: 'POST',
      url: '/api/auth/verify',
      payload: `t=${encodeURIComponent(t)}`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie ? { cookie } : {}),
      },
      remoteAddress: addr(),
    });
  }

  it('request → mail → confirm page → verify → /api/me is registered (guest row claimed)', async () => {
    const g = await guest();
    db.prepare('UPDATE users SET elo = 1111, display_name = ? WHERE id = ?').run('Gus', g.me.id);
    const r = await request('  Alice@Example.COM ', g.cookie);
    expect(r.statusCode).toBe(202);
    const mail = mailer.outbox.at(-1)!;
    expect(mail.to).toBe('alice@example.com');
    expect(mail.subject).toContain('Voicejack');
    expect(mail.html).not.toMatch(/<img|<script|https?:\/\/(?!vj\.example|voicejack\.borbus\.eu)/);
    const link = lastLink('alice@example.com');
    // Tokens are stored hashed.
    const t = tokenOf(link);
    expect(JSON.stringify(db.prepare('SELECT * FROM login_tokens').all())).not.toContain(t);

    const page = await app.inject({ url: link.replace(PUBLIC, '') });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.body).toContain('alice@example.com');
    expect(page.body).toContain('method="post"');

    const v = await confirm(t, g.cookie);
    expect(v.statusCode).toBe(303);
    expect(v.headers.location).toBe('/?login=ok');
    const c2 = cookieOf(v)!;
    expect(c2).not.toBe(g.cookie);
    const u = await me(c2);
    expect(u).toMatchObject({
      id: g.me.id,
      kind: 'registered',
      email: 'alice@example.com',
      elo: 1111,
      displayName: 'Gus',
    });
    // Session rotated: the old guest cookie no longer works.
    expect(accounts.session(g.cookie.split('=')[1])).toBeNull();
  });

  it('answers 202 the same way whether or not an account exists', async () => {
    const a = await request('alice@example.com');
    const b = await request('nobody@example.com');
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    expect(a.body).toBe(b.body);
    expect((await request('not-an-email')).statusCode).toBe(400);
    const form = await app.inject({
      method: 'POST',
      url: '/api/auth/request',
      payload: 'email=x%40example.com',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      remoteAddress: addr(),
    });
    expect(form.statusCode).toBe(415);
  });

  it('a token works once', async () => {
    const g = await guest();
    await request('once@example.com', g.cookie);
    const t = tokenOf(lastLink('once@example.com'));
    expect((await confirm(t)).headers.location).toBe('/?login=ok');
    const again = await confirm(t);
    expect(again.headers.location).toBe('/?login=invalid');
    expect(cookieOf(again)).toBeNull();
    expect((await app.inject({ url: `/api/auth/verify?t=${t}` })).statusCode).toBe(410);
  });

  it('a token expires after 15 minutes; expired tokens are pruned', async () => {
    const g = await guest();
    await request('late@example.com', g.cookie);
    const t = tokenOf(lastLink('late@example.com'));
    now += LOGIN_TOKEN_TTL_MS + 1;
    expect((await app.inject({ url: `/api/auth/verify?t=${t}` })).statusCode).toBe(410);
    expect((await confirm(t)).headers.location).toBe('/?login=invalid');
    expect((await me(g.cookie)).kind).toBe('guest');
    now += LOGIN_TOKEN_TTL_MS;
    expect(accounts.cleanup().loginTokens).toBeGreaterThanOrEqual(1);
    const left = db.prepare('SELECT COUNT(*) AS n FROM login_tokens WHERE email = ?').get(
      'late@example.com',
    ) as { n: number };
    expect(left.n).toBe(0);
  });

  it('a scanner GET (confirm page) does not consume the token', async () => {
    const g = await guest();
    await request('scan@example.com', g.cookie);
    const link = lastLink('scan@example.com');
    for (let i = 0; i < 3; i++) {
      expect((await app.inject({ url: link.replace(PUBLIC, '') })).statusCode).toBe(200);
    }
    expect((await me(g.cookie)).kind).toBe('guest');
    expect((await confirm(tokenOf(link))).headers.location).toBe('/?login=ok');
  });

  it('rate limits: 3 per address per 15 min, 10 per IP per hour', async () => {
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await request('spam@example.com')).statusCode);
    expect(codes).toEqual([202, 202, 202, 429]);
    expect(mailer.outbox.filter((m) => m.to === 'spam@example.com')).toHaveLength(3);
    now += 15 * 60_000 + 1;
    expect((await request('spam@example.com')).statusCode).toBe(202);

    now += 3600_000; // fresh IP window
    const perIp = [];
    for (let i = 0; i < 11; i++) perIp.push((await request(`ip${i}@example.com`)).statusCode);
    expect(perIp.slice(0, 10).every((c) => c === 202)).toBe(true);
    expect(perIp[10]).toBe(429);
    expect((await request('other@example.com', undefined, '10.9.9.9')).statusCode).toBe(202);
  });

  it('logout starts a fresh guest session', async () => {
    const g = await guest();
    await request('bye@example.com', g.cookie);
    const c = cookieOf(await confirm(tokenOf(lastLink('bye@example.com'))))!;
    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: c },
      remoteAddress: addr(),
    });
    expect(out.statusCode).toBe(200);
    const fresh = out.json<MeResponse>().user;
    expect(fresh).toMatchObject({ kind: 'guest', email: null });
    expect(fresh.id).not.toBe(g.me.id);
    expect(accounts.session(c.split('=')[1])).toBeNull();
    expect((await me(cookieOf(out)!)).id).toBe(fresh.id);
  });

  it('PATCH /api/me renames (1–20 chars)', async () => {
    const g = await guest();
    const patch = (displayName: string) =>
      app.inject({
        method: 'PATCH',
        url: '/api/me',
        payload: { displayName },
        headers: { cookie: g.cookie },
        remoteAddress: addr(),
      });
    const ok = await patch('  Dubster ');
    expect(ok.statusCode).toBe(200);
    expect(ok.json<MeResponse>().user.displayName).toBe('Dubster');
    expect((await patch('')).statusCode).toBe(400);
    expect((await patch('x'.repeat(21))).statusCode).toBe(400);
    const anon = await app.inject({ method: 'PATCH', url: '/api/me', payload: { displayName: 'A' } });
    expect(anon.statusCode).toBe(401);
  });

  it('DELETE /api/me anonymizes the account and ends every session', async () => {
    const g = await guest();
    await request('gone@example.com', g.cookie);
    const c1 = cookieOf(await confirm(tokenOf(lastLink('gone@example.com'))))!;
    // Second device.
    await request('gone@example.com');
    const c2 = cookieOf(await confirm(tokenOf(lastLink('gone@example.com'))))!;
    expect((await me(c2)).id).toBe(g.me.id);
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/me',
      headers: { cookie: c1 },
      remoteAddress: addr(),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json<MeResponse>().user.kind).toBe('guest');
    expect(accounts.session(c1.split('=')[1])).toBeNull();
    expect(accounts.session(c2.split('=')[1])).toBeNull();
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(g.me.id) as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({ kind: 'guest', email: null, display_name: '' });
    expect(row.deleted_at).toBe(now);
    // The address can sign up again, as a new account.
    const g2 = await guest();
    await request('gone@example.com', g2.cookie);
    const c3 = cookieOf(await confirm(tokenOf(lastLink('gone@example.com'))))!;
    expect(await me(c3)).toMatchObject({ id: g2.me.id, kind: 'registered' });
  });

  it('existing account: the session switches to it (stats kept; guest stats only if it has none)', async () => {
    const first = await guest();
    await request('merge@example.com', first.cookie);
    await confirm(tokenOf(lastLink('merge@example.com')));
    db.prepare('UPDATE users SET elo = 1200, public_games_played = 5 WHERE id = ?').run(
      first.me.id,
    );

    // A new browser's guest with its own games signs in to the same address.
    const other = await guest();
    db.prepare('UPDATE users SET elo = 900, public_games_played = 2 WHERE id = ?').run(
      other.me.id,
    );
    await request('merge@example.com', other.cookie);
    const c = cookieOf(await confirm(tokenOf(lastLink('merge@example.com'))))!;
    expect(await me(c)).toMatchObject({ id: first.me.id, elo: 1200, publicGamesPlayed: 5 });
    // The guest row stays a guest and is signed out.
    expect(accounts.getUser(other.me.id)).toMatchObject({ kind: 'guest', email: null });
    expect(accounts.session(other.cookie.split('=')[1])).toBeNull();

    // An account without public games adopts the guest's rating.
    const fresh = await guest();
    await request('newbie@example.com', fresh.cookie);
    await confirm(tokenOf(lastLink('newbie@example.com')));
    const played = await guest();
    db.prepare('UPDATE users SET elo = 1300, public_games_played = 4 WHERE id = ?').run(
      played.me.id,
    );
    await request('newbie@example.com', played.cookie);
    const c2 = cookieOf(await confirm(tokenOf(lastLink('newbie@example.com'))))!;
    expect(await me(c2)).toMatchObject({ id: fresh.me.id, elo: 1300, publicGamesPlayed: 4 });
  });
});

describe('SMTP client', () => {
  it('speaks plain SMTP to a relay (dot-stuffing, multi-line replies)', async () => {
    const got: string[] = [];
    const server = net.createServer((sock) => {
      sock.setEncoding('utf8');
      let inData = false;
      let buf = '';
      sock.write('220 relay ESMTP\r\n');
      sock.on('data', (d: string) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          got.push(line);
          if (inData) {
            if (line === '.') {
              inData = false;
              sock.write('250 2.0.0 queued\r\n');
            }
            continue;
          }
          if (line.startsWith('EHLO')) sock.write('250-relay\r\n250-PIPELINING\r\n250 8BITMIME\r\n');
          else if (line === 'DATA') {
            inData = true;
            sock.write('354 go\r\n');
          } else if (line === 'QUIT') sock.end('221 bye\r\n');
          else sock.write('250 ok\r\n');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    await sendSmtp(
      { host: '127.0.0.1', port },
      {
        from: 'Voicejack <noreply@borbus.eu>',
        to: 'a@example.com',
        subject: 'Hi',
        text: 'x',
        html: '<p>x</p>',
      },
    );
    server.close();
    expect(got).toContain('MAIL FROM:<noreply@borbus.eu>');
    expect(got).toContain('RCPT TO:<a@example.com>');
    expect(got).toContain('From: Voicejack <noreply@borbus.eu>');
    expect(got.indexOf('.')).toBeGreaterThan(got.indexOf('DATA'));
  });

  it('rejects header injection and fails on a refused recipient', async () => {
    expect(() =>
      buildMessage({ from: 'a@b', to: 'x@y\r\nBcc: z@w', subject: 's', text: '', html: '' }),
    ).toThrow();
    const server = net.createServer((sock) => {
      sock.write('220 hi\r\n');
      sock.on('data', (d) => {
        const l = String(d);
        sock.write(l.startsWith('RCPT') ? '554 5.7.1 relay denied\r\n' : '250 ok\r\n');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    await expect(
      sendSmtp(
        { host: '127.0.0.1', port },
        { from: 'n@b.eu', to: 'a@example.com', subject: 's', text: 't', html: 'h' },
      ),
    ).rejects.toThrow(/relay denied/);
    server.close();
  });
});
