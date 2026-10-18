import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  DMS_PER_MINUTE,
  FRIEND_REQUESTS_PER_DAY,
  FRIEND_SEARCHES_PER_MINUTE,
  friendPaths,
  type FriendSearchResponse,
  sanitizeDmBody,
  type ClipInfo,
  type FriendsResponse,
  type PresenceS2C,
} from '@dub/shared';
import { buildApp } from '../src/http/app.js';
import { ClipLibrary } from '../src/clips/ClipLibrary.js';
import { openDb, type Db } from '../src/db/index.js';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { Accounts, DM_RETENTION_MS } from '../src/accounts/Accounts.js';
import { Friends } from '../src/friends/Friends.js';
import { Presence, type PresenceClient } from '../src/presence/Presence.js';
import { RoomManager, type Connection } from '../src/room/RoomManager.js';
import type { Room } from '../src/room/Room.js';
import { makeClipsDir, testConfig } from './helpers.js';

const clip = (id: string): ClipInfo => ({
  id,
  title: id,
  url: `/clips/${id}.mp4`,
  durationMs: 8000,
  width: 640,
  height: 360,
  tags: [],
  attribution: { author: 'a', source: 's', license: 'CC0' },
});

class FakeClient implements PresenceClient {
  readonly got: PresenceS2C[] = [];
  send(m: PresenceS2C) {
    this.got.push(m);
  }
  close() {}
  of<T extends PresenceS2C['t']>(t: T) {
    return this.got.filter((m): m is Extract<PresenceS2C, { t: T }> => m.t === t);
  }
}

/** Runs presence flushes synchronously (no throttle) so pushes are observable at once. */
const syncScheduler = {
  setTimeout: (fn: () => void) => {
    fn();
    return null;
  },
  clearTimeout: () => {},
};

describe('V10 friends', () => {
  let db: Db;
  let now: number;
  let accounts: Accounts;
  let rooms: RoomManager;
  let presence: Presence;
  let friends: Friends;
  let app: FastifyInstance;
  const cookies = new Map<string, string>();

  function user(name: string, kind: 'guest' | 'registered' = 'registered'): string {
    const u = accounts.createGuest();
    if (kind === 'registered') {
      db.prepare("UPDATE users SET kind = 'registered', email = ? WHERE id = ?").run(
        `${u.id}@example.com`,
        u.id,
      );
    }
    accounts.setDisplayName(u.id, name);
    cookies.set(u.id, `vj_session=${accounts.createSession(u.id).token}`);
    return u.id;
  }

  function call(
    uid: string,
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
    url: string,
    payload?: object,
  ) {
    return app.inject({ method, url, payload, headers: { cookie: cookies.get(uid)! } });
  }

  /** Host room with `hostUid`, plus one player per extra uid. Returns playerIds by uid. */
  function room(hostUid: string, ...others: (string | null)[]): { room: Room; pids: string[] } {
    const made = rooms.create('Host');
    if (!('room' in made)) throw new Error((made as { message: string }).message);
    const r = made.room;
    r.linkUser(made.join.playerId, hostUid);
    const pids = [made.join.playerId];
    others.forEach((uid, i) => {
      const j = r.join(`P${i}`);
      if ('code' in j) throw new Error(j.message);
      if (uid) r.linkUser(j.playerId, uid);
      pids.push(j.playerId);
    });
    return { room: r, pids };
  }

  async function befriend(a: string, b: string): Promise<void> {
    const { room: r, pids } = room(a, b);
    expect(
      (await call(a, 'POST', friendPaths.fromRoom(), { code: r.code, playerId: pids[1] })).json(),
    ).toEqual({ result: 'requested' });
    expect(
      (await call(b, 'POST', friendPaths.fromRoom(), { code: r.code, playerId: pids[0] })).json(),
    ).toEqual({ result: 'accepted' });
  }

  beforeEach(async () => {
    now = Date.UTC(2026, 9, 1);
    db = openDb(':memory:');
    migrate(db);
    accounts = new Accounts(db, () => now);
    rooms = new RoomManager({
      config: testConfig({ allowSolo: true }),
      clips: [clip('a'), clip('b')],
    });
    presence = new Presence({ rooms, scheduler: syncScheduler, clock: { now: () => now } });
    friends = new Friends({ db, presence, rooms, now: () => now });
    app = await buildApp({
      config: testConfig(),
      clips: ClipLibrary.load(makeClipsDir(1)),
      rooms,
      accounts,
      presence,
      friends,
    });
  });
  afterEach(async () => {
    await app.close();
    friends.dispose();
    presence.dispose();
    await rooms.stop();
    db.close();
  });

  it('request → accept → friendStatus push, then live online/offline/inGame', async () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const aliceTab = new FakeClient();
    presence.add(aliceTab, alice);
    const { room: r, pids } = room(alice, bob);

    const rel = await call(alice, 'GET', friendPaths.room(r.code));
    expect(rel.json()).toEqual({ players: { [pids[1]!]: 'none' } });

    const bobTab = new FakeClient();
    const removeBob = presence.add(bobTab, bob);
    expect(
      (
        await call(alice, 'POST', friendPaths.fromRoom(), { code: r.code, playerId: pids[1] })
      ).json(),
    ).toEqual({ result: 'requested' });
    expect(bobTab.of('friends').length).toBe(1);

    const bobList = (await call(bob, 'GET', friendPaths.friends())).json<FriendsResponse>();
    expect(bobList.incoming).toHaveLength(1);
    expect(bobList.incoming[0]!.name).toBe('Alice');
    expect(JSON.stringify(bobList)).not.toContain(alice);

    const ok = await call(bob, 'POST', friendPaths.request(bobList.incoming[0]!.ref), {
      action: 'accept',
    });
    expect(ok.statusCode).toBe(200);
    expect(aliceTab.of('friendStatus').at(-1)).toEqual({
      t: 'friendStatus',
      userId: bob,
      status: 'online',
    });

    const aliceList = (await call(alice, 'GET', friendPaths.friends())).json<FriendsResponse>();
    expect(aliceList.friends).toMatchObject([
      { userId: bob, name: 'Bob', status: 'online', unread: 0 },
    ]);

    removeBob();
    expect(aliceTab.of('friendStatus').at(-1)).toMatchObject({ userId: bob, status: 'offline' });

    // Bob's room socket while the room is in a game → inGame.
    (r as unknown as { phase: string }).phase = 'DUBBING';
    const conn: Connection = { send: () => {}, close: () => {} };
    rooms.attach(r.code, pids[1]!, conn);
    expect(aliceTab.of('friendStatus').at(-1)).toMatchObject({ userId: bob, status: 'inGame' });
  });

  it('addFromRoom resolves players server-side and never leaks account ids', async () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const guest = user('Guesty', 'guest');
    const outsider = user('Eve');
    const { room: r, pids } = room(alice, bob, guest, null);

    const rel = (await call(alice, 'GET', friendPaths.room(r.code))).json<{ players: object }>();
    // Only registered humans other than the caller; guests and accountless players are absent.
    expect(Object.keys(rel.players)).toEqual([pids[1]]);
    expect(JSON.stringify(rel)).not.toContain(bob);

    const res = await call(alice, 'POST', friendPaths.fromRoom(), {
      code: r.code,
      playerId: pids[1],
    });
    expect(res.body).not.toContain(bob);
    expect(res.json()).toEqual({ result: 'requested' });
    const out = (await call(alice, 'GET', friendPaths.friends())).json<FriendsResponse>();
    expect(out.outgoing).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain(bob);

    for (const pid of [pids[2], pids[3], pids[0]]) {
      const bad = await call(alice, 'POST', friendPaths.fromRoom(), {
        code: r.code,
        playerId: pid,
      });
      expect(bad.statusCode).toBe(404);
    }
    // Not in that room → can't probe it.
    const probe = await call(outsider, 'POST', friendPaths.fromRoom(), {
      code: r.code,
      playerId: pids[1],
    });
    expect(probe.statusCode).toBe(404);
    expect((await call(outsider, 'GET', friendPaths.room(r.code))).statusCode).toBe(404);
    // Guests can't use friends at all.
    expect((await call(guest, 'GET', friendPaths.friends())).statusCode).toBe(403);
  });

  it(`limits friend requests to ${FRIEND_REQUESTS_PER_DAY} a day`, () => {
    const me = user('Me');
    const targets = Array.from({ length: FRIEND_REQUESTS_PER_DAY + 1 }, (_, i) => user(`T${i}`));
    for (const t of targets.slice(0, -1)) expect(friends.request(me, t)).toBe('requested');
    expect(() => friends.request(me, targets.at(-1)!)).toThrow(/a day/);
    now += 24 * 3600_000 + 1;
    expect(friends.request(me, targets.at(-1)!)).toBe('requested');
  });

  it('DMs: plain text, live push, unread count, paging, rate limit', async () => {
    const alice = user('Alice');
    const bob = user('Bob');
    await befriend(alice, bob);
    const bobTab = new FakeClient();
    presence.add(bobTab, bob);

    const sent = await call(alice, 'POST', friendPaths.messages(bob), {
      body: ' hi\u0007 <b>bob</b>‮ ',
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().message).toMatchObject({ from: alice, to: bob, body: 'hi <b>bob</b>' });
    expect(bobTab.of('dm').at(-1)!.message.body).toBe('hi <b>bob</b>');
    expect(
      (await call(alice, 'POST', friendPaths.messages(bob), { body: '\u0000\u0001 ' })).statusCode,
    ).toBe(400);
    expect(
      (await call(alice, 'POST', friendPaths.messages(bob), { body: 'x'.repeat(501) })).statusCode,
    ).toBe(400);

    let list = (await call(bob, 'GET', friendPaths.friends())).json<FriendsResponse>();
    expect(list.friends[0]!.unread).toBe(1);
    const hist = await call(bob, 'GET', friendPaths.messages(alice));
    expect(hist.json()).toMatchObject({ more: false, messages: [{ body: 'hi <b>bob</b>' }] });
    list = (await call(bob, 'GET', friendPaths.friends())).json<FriendsResponse>();
    expect(list.friends[0]!.unread).toBe(0);

    for (let i = 1; i < DMS_PER_MINUTE; i++) {
      expect(
        (await call(alice, 'POST', friendPaths.messages(bob), { body: `m${i}` })).statusCode,
      ).toBe(200);
    }
    const limited = await call(alice, 'POST', friendPaths.messages(bob), { body: 'too many' });
    expect(limited.statusCode).toBe(429);
    now += 60_001;
    expect(
      (await call(alice, 'POST', friendPaths.messages(bob), { body: 'again' })).statusCode,
    ).toBe(200);

    for (let i = 0; i < 40; i++) (friends.sendDm(bob, alice, `b${i}`), (now += 3001));
    const page1 = (await call(alice, 'GET', friendPaths.messages(bob))).json();
    expect(page1.messages).toHaveLength(50);
    expect(page1.more).toBe(true);
    expect(page1.messages.at(-1).body).toBe('b39');
    const page2 = (
      await call(alice, 'GET', friendPaths.messages(bob, page1.messages[0].id))
    ).json();
    expect(page2.more).toBe(false);
    expect(page2.messages[0].body).toBe('hi <b>bob</b>');

    // 90-day retention.
    now += DM_RETENTION_MS - 100_000;
    expect(accounts.cleanup().messages).toBeGreaterThan(0);
    expect(friends.messages(alice, bob).messages.length).toBeLessThan(42);
    expect(sanitizeDmBody('a\n\n\n\nb\r\nc')).toBe('a\n\nb\nc');
  });

  it('block stops DMs and invites; unblock by ref', async () => {
    const alice = user('Alice');
    const bob = user('Bob');
    await befriend(alice, bob);
    const { room: lobby } = room(alice);
    const bobTab = new FakeClient();
    presence.add(bobTab, bob);
    expect(
      (await call(alice, 'POST', friendPaths.invite(bob), { code: lobby.code })).statusCode,
    ).toBe(200);
    expect(bobTab.of('invite').at(-1)).toEqual({
      t: 'invite',
      from: alice,
      fromName: 'Alice',
      code: lobby.code,
    });

    expect((await call(bob, 'POST', friendPaths.blockFriend(alice))).statusCode).toBe(200);
    const before = bobTab.of('invite').length;
    expect(
      (await call(alice, 'POST', friendPaths.invite(bob), { code: lobby.code })).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(bobTab.of('invite').length).toBe(before);
    expect(
      (await call(alice, 'POST', friendPaths.messages(bob), { body: 'hey' })).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(bobTab.of('dm')).toHaveLength(0);
    // The blocked side can't re-request either.
    expect(() => friends.request(alice, bob)).toThrow();
    expect(() => friends.request(bob, alice)).toThrow();

    const list = (await call(bob, 'GET', friendPaths.friends())).json<FriendsResponse>();
    expect(list.friends).toEqual([]);
    expect(list.blocked).toHaveLength(1);
    expect((await call(bob, 'DELETE', friendPaths.block(list.blocked[0]!.ref))).statusCode).toBe(
      200,
    );
    expect(friends.request(alice, bob)).toBe('requested');
  });

  it('invites only from the host of a lobby, to online friends', async () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const carol = user('Carol');
    const dave = user('Dave');
    await befriend(alice, bob);
    await befriend(alice, carol);
    const { room: r } = room(alice, bob);

    const aliceTab = new FakeClient();
    presence.add(aliceTab, alice);
    // Bob is in the room but not the host.
    expect(
      (await call(bob, 'POST', friendPaths.invite(alice), { code: r.code })).json(),
    ).toMatchObject({ error: 'NOT_HOST' });
    // Carol is offline.
    expect(
      (await call(alice, 'POST', friendPaths.invite(carol), { code: r.code })).statusCode,
    ).toBe(409);
    // Dave is not a friend.
    expect((await call(alice, 'POST', friendPaths.invite(dave), { code: r.code })).statusCode).toBe(
      404,
    );
    const bobTab = new FakeClient();
    presence.add(bobTab, bob);
    expect((await call(alice, 'POST', friendPaths.invite(bob), { code: r.code })).statusCode).toBe(
      200,
    );
    (r as unknown as { phase: string }).phase = 'DUBBING';
    expect(
      (await call(alice, 'POST', friendPaths.invite(bob), { code: r.code })).json(),
    ).toMatchObject({ error: 'BAD_PHASE' });
    expect(bobTab.of('invite')).toHaveLength(1);
    expect(aliceTab.of('invite')).toHaveLength(0);
  });

  // V08 owns the `reports` table (003_reports.sql); skipped on a tree without it.
  it.skipIf(!loadMigrations().some((m) => m.name === '003_reports.sql'))(
    'reports a DM into V08 reports',
    async () => {
      const alice = user('Alice');
      const bob = user('Bob');
      await befriend(alice, bob);
      const m = friends.sendDm(bob, alice, 'rude words');
      const rep = await call(alice, 'POST', friendPaths.report(bob), {
        reason: 'spam',
        messageId: m.id,
      });
      expect(rep.statusCode).toBe(200);
      const row = db.prepare('SELECT * FROM reports').get() as Record<string, unknown> & {
        reason: string;
      };
      expect(row).toMatchObject({
        context: 'dm',
        reporter_user_id: alice,
        reported_user_id: bob,
        reported_name: 'Bob',
      });
      expect(row.reason).toContain('rude words');
    },
  );

  it('account deletion cascades friends, blocks and DMs', async () => {
    const alice = user('Alice');
    const bob = user('Bob');
    const carol = user('Carol');
    await befriend(alice, bob);
    friends.request(alice, carol);
    friends.request(bob, carol);
    friends.requestAction(carol, Friends.ref(carol, bob), 'block');
    friends.sendDm(bob, alice, 'hi');
    friends.sendDm(alice, bob, 'reply');

    const count = (sql: string, ...a: string[]) =>
      Number((db.prepare(sql).get(...a) as { n: number }).n);
    accounts.deleteAccount(bob);
    expect(
      count('SELECT COUNT(*) AS n FROM friendships WHERE user_a = ? OR user_b = ?', bob, bob),
    ).toBe(0);
    expect(
      count('SELECT COUNT(*) AS n FROM blocks WHERE blocker = ? OR blocked = ?', bob, bob),
    ).toBe(0);
    expect(
      count('SELECT COUNT(*) AS n FROM messages WHERE sender = ? OR recipient = ?', bob, bob),
    ).toBe(0);
    // Alice's other relations stay.
    expect(
      count('SELECT COUNT(*) AS n FROM friendships WHERE user_a = ? OR user_b = ?', alice, alice),
    ).toBe(1);
    expect(friends.list(alice).friends).toEqual([]);
  });

  describe('search (v1.2 #44)', () => {
    const search = async (uid: string, q: string) =>
      (await call(uid, 'GET', friendPaths.search(q))).json<FriendSearchResponse>().results;

    it('prefix, case-insensitive, registered + discoverable + unblocked only, no ids', async () => {
      const me = user('Searcher');
      const bob1 = user('Bobby');
      const bob2 = user('bobcat');
      user('BOBO', 'guest');
      user('Rob Bob');
      const blocker = user('Bobblocker');
      const blocked = user('Bobblocked');
      const hidden = user('Bobhidden');
      const deleted = user('Bobdeleted');
      user('Ölaf');
      friends.request(blocker, me);
      friends.requestAction(blocker, Friends.ref(blocker, me), 'block');
      friends.request(me, blocked);
      friends.requestAction(me, Friends.ref(me, blocked), 'block');
      friends.setDiscoverable(hidden, false);
      accounts.deleteAccount(deleted);

      const res = await call(me, 'GET', friendPaths.search('bOb'));
      expect(res.statusCode).toBe(200);
      const { results } = res.json<FriendSearchResponse>();
      expect(results.map((r) => r.name).sort()).toEqual(['Bobby', 'bobcat']);
      for (const id of [me, bob1, bob2]) expect(res.body).not.toContain(id);
      expect(res.body).not.toContain('@example.com');
      expect(results[0]).toEqual({
        ref: expect.any(String),
        name: expect.any(String),
        avatarSeed: expect.any(String),
        tag: expect.stringMatching(/^[a-z0-9]{4}$/),
        joined: '2026-10',
        relation: 'none',
      });
      expect((await search(me, 'öla')).map((r) => r.name)).toEqual(['Ölaf']);
      // LIKE wildcards are literal.
      expect(await search(me, 'b%b')).toEqual([]);
      expect(await search(me, 'Sea')).toEqual([]); // never yourself
    });

    it('needs ≥ 3 characters, registered caller, at most 10 results, rate limited', async () => {
      const me = user('Me');
      const guest = user('Guest', 'guest');
      for (let i = 0; i < 12; i++) user(`Sam${i}`);
      expect((await call(me, 'GET', friendPaths.search('Sa'))).statusCode).toBe(400);
      expect((await call(guest, 'GET', friendPaths.search('Sam'))).statusCode).toBe(403);
      expect(await search(me, 'sam')).toHaveLength(10);
      for (let i = 1; i < FRIEND_SEARCHES_PER_MINUTE; i++) await search(me, 'sam');
      expect((await call(me, 'GET', friendPaths.search('sam'))).statusCode).toBe(429);
    });

    it('add by ref sends a request; refs are per searcher; discoverable toggle', async () => {
      const me = user('Alice');
      const bob = user('Bobby');
      const eve = user('Eve');
      const [hit] = await search(me, 'bob');
      // Another user can't use Alice's ref (and never saw it).
      expect((await call(eve, 'POST', friendPaths.add(), { ref: hit!.ref })).statusCode).toBe(404);
      const add = await call(me, 'POST', friendPaths.add(), { ref: hit!.ref });
      expect(add.json()).toEqual({ result: 'requested' });
      expect(friends.list(bob).incoming.map((r) => r.name)).toEqual(['Alice']);
      expect((await search(me, 'bob'))[0]!.relation).toBe('outgoing');

      expect((await call(bob, 'GET', friendPaths.settings())).json()).toEqual({
        discoverable: true,
      });
      const off = await call(bob, 'PATCH', friendPaths.settings(), { discoverable: false });
      expect(off.json()).toEqual({ discoverable: false });
      expect(await search(me, 'bob')).toEqual([]);
      expect(await search(eve, 'bob')).toEqual([]);
      // An old ref stops working once the target hides.
      expect((await call(me, 'POST', friendPaths.add(), { ref: hit!.ref })).statusCode).toBe(404);
    });
  });
});
