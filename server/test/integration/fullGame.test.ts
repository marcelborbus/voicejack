import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoomSnapshot } from '@dub/shared';
import { loadConfig } from '../../src/config.js';
import { startServer, type RunningServer } from '../../src/bootstrap.js';
import { tmpDir } from '../helpers.js';
import { FakeClient, chunkMeta, makeFixtureClips } from './fakeClient.js';

let srv: RunningServer;
const clients: FakeClient[] = [];

beforeAll(async () => {
  const config = loadConfig({
    TIMINGS: 'fast',
    PORT: '0',
    HOST: '127.0.0.1',
    CLIPS_DIR: makeFixtureClips(3, 500),
    DATA_DIR: tmpDir('dub-int-data-'),
    CLIENT_DIST: tmpDir('dub-int-noclient-'),
  });
  srv = await startServer(config);
}, 30_000);

afterAll(async () => {
  for (const c of clients) await c.drop();
  await srv?.close();
});

const ROUNDS = 2;

describe('full game over WS + REST', () => {
  it('3 players, 2 rounds, reconnect mid-round, to FINAL', { timeout: 20_000 }, async () => {
    // --- create + join
    const res = await fetch(srv.url + '/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ann' }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { code: string; token: string; playerId: string };
    const ann = new FakeClient(srv.url, created.code, 'Ann', created.token);
    const bob = new FakeClient(srv.url, created.code, 'Bob');
    const cid = new FakeClient(srv.url, created.code, 'Cid');
    const all = [ann, bob, cid];
    clients.push(...all);
    for (const c of all) await c.connect();
    expect(ann.playerId).toBe(created.playerId);
    await ann.state((s) => s.players.length === 3 && s.players.every((p) => p.connected));

    // --- settings, mic, ready, start
    ann.send({
      t: 'updateSettings',
      settings: { mode: 'extended', rounds: ROUNDS, dubbingSeconds: 5 },
    });
    await ann.state((s) => s.settings.mode === 'extended' && s.settings.rounds === ROUNDS);
    for (const c of all) {
      c.send({ t: 'micStatus', ok: true });
      c.send({ t: 'setReady', ready: true });
    }
    await ann.state((s) => s.you.canStart);
    ann.send({ t: 'startGame' });

    const clipIds: string[] = [];
    const clipsOf = new Map<string, string[]>(all.map((c) => [c.playerId, []]));
    for (let round = 0; round < ROUNDS; round++) {
      // --- DUBBING
      const states = await Promise.all(
        all.map((c) => c.state((s) => s.phase === 'DUBBING' && s.round === round)),
      );
      // V14: every player dubs a different clip and never gets one twice.
      const dealt = states.map((s) => s.you.clip!.id);
      expect(new Set(dealt).size).toBe(3);
      all.forEach((c, i) => clipsOf.get(c.playerId)!.push(dealt[i]!));
      clipIds.push(...dealt);
      const subs = new Map(all.map((c, i) => [c.playerId, states[i]!.you.submissionId!]));
      expect(new Set(subs.values()).size).toBe(3);

      for (const c of all) {
        const chunks = [
          chunkMeta(`${c.name}-${round}-a`, 0, 64),
          chunkMeta(`${c.name}-${round}-b`, 300, 96),
        ];
        for (const k of chunks) {
          const r = await c.upload(round, k.id, Buffer.alloc(k.bytes, 1));
          expect(r.status).toBe(201);
        }
        c.send({ t: 'manifest', round, chunks });
      }

      if (round === 0) {
        // Bob drops and reconnects by token: same player, manifest restored.
        await ann.state((s) => s.phase === 'DUBBING'); // flush
        await bob.state((s) => s.you.manifest.length === 2);
        const bobId = bob.playerId;
        await bob.drop();
        await ann.state((s) => s.players.find((p) => p.id === bobId)!.connected === false);
        const w = await bob.connect();
        expect(w.playerId).toBe(bobId);
        const restored = await bob.state((s) => s.you.manifest.length === 2);
        expect(restored.you.submissionId).toBe(subs.get(bobId));
        expect(restored.you.uploaded.sort()).toEqual([`Bob-0-a`, `Bob-0-b`]);
        // owner can re-download own chunk while dubbing; others cannot
        const own = await bob.download(
          `/api/rooms/${created.code}/rounds/0/subs/${subs.get(bobId)}/chunks/Bob-0-a`,
        );
        expect(own.status).toBe(200);
        expect((await own.arrayBuffer()).byteLength).toBe(64);
        const peek = await ann.download(
          `/api/rooms/${created.code}/rounds/0/subs/${subs.get(bobId)}/chunks/Bob-0-a`,
        );
        expect(peek.status).toBe(403);
      }

      for (const c of all) c.send({ t: 'dubDone', round, done: true });

      // --- SHOWCASE: 3 items
      for (let i = 0; i < 3; i++) {
        const loading = await Promise.all(
          all.map((c) =>
            c.state(
              (s) =>
                s.phase === 'SHOWCASE' &&
                s.showcase!.index === i &&
                s.showcase!.status === 'LOADING',
              8000,
            ),
          ),
        );
        const item = loading[0]!.showcase!;
        expect(item.total).toBe(3);
        expect(item.chunks).toHaveLength(2);
        // The item carries its author's clip (chunk ids are prefixed with the author's name).
        const author = all.find((c) => item.chunks[0]!.id.startsWith(`${c.name}-`))!;
        expect(item.clip.id).toBe(clipsOf.get(author.playerId)![round]);
        // members can fetch every chunk once finalized
        for (const ch of item.chunks) {
          const r = await cid.download(ch.url);
          expect(r.status).toBe(200);
          expect((await r.arrayBuffer()).byteLength).toBe(ch.bytes);
        }
        for (const c of all) c.send({ t: 'preloaded', submissionId: item.submissionId });
        const playing = await Promise.all(
          all.map((c) =>
            c.state((s) => s.showcase?.index === i && s.showcase.status === 'PLAYING'),
          ),
        );
        expect(playing[0]!.showcase!.startAt).not.toBeNull();
        for (const [k, c] of all.entries()) {
          const s = playing[k]!;
          if (s.you.isOwnItem) {
            c.send({ t: 'vote', submissionId: item.submissionId, score: 10 });
            await c.wait((m) => m.t === 'error' && m.code === 'SELF_VOTE');
          } else {
            c.send({ t: 'vote', submissionId: item.submissionId, score: 3 });
            c.send({ t: 'vote', submissionId: item.submissionId, score: 2 + k * 2 }); // last vote counts
            await c.wait((m) => m.t === 'voteAck' && m.score === 2 + k * 2);
          }
        }
        await ann.state(
          (s) =>
            s.showcase?.index === i &&
            s.showcase.status === 'PLAYING' &&
            s.showcase.votesCast === 2,
        );
        await ann.state(
          (s) => s.phase !== 'SHOWCASE' || s.showcase!.index > i || s.showcase!.status === 'LOCKED',
          5000,
        );
      }

      // --- ROUND_RESULTS
      const rr = await ann.state((s) => s.phase === 'ROUND_RESULTS' && s.round === round, 8000);
      const entries = rr.roundResult!.entries;
      expect(entries).toHaveLength(3);
      // votes per author: Ann gets (Bob 4, Cid 6) → 50; Bob gets (Ann 2, Cid 6) → 40; Cid gets (2, 4) → 30
      const pts = Object.fromEntries(entries.map((e) => [e.name, e.points]));
      expect(pts).toEqual({ Ann: 50, Bob: 40, Cid: 30 });
      expect(entries.map((e) => e.name)).toEqual(['Ann', 'Bob', 'Cid']);
      for (const e of entries) expect(e.clip.id).toBe(clipsOf.get(e.playerId)![round]);
      if (round === 0) ann.send({ t: 'advance' }); // host skip; round 1 auto-advances
    }

    // --- FINAL
    const fin = await Promise.all(all.map((c) => c.state((s) => s.phase === 'FINAL', 8000)));
    const f = fin[0]!.final!;
    expect(f.winners).toEqual([ann.playerId]);
    expect(f.standings.map((s) => [s.name, s.total, s.roundWins])).toEqual([
      ['Ann', 100, 2],
      ['Bob', 80, 0],
      ['Cid', 60, 0],
    ]);
    expect(f.bestDub).toMatchObject({ round: 1, playerId: ann.playerId, points: 50 });
    expect(f.bestDub!.chunks.map((c) => c.id)).toEqual(['Ann-1-a', 'Ann-1-b']);
    const best = await bob.download(f.bestDub!.chunks[0]!.url);
    expect(best.status).toBe(200);
    expect(f.bestDub!.clip.id).toBe(clipsOf.get(ann.playerId)![1]);
    expect(new Set(clipIds).size).toBe(3);
    for (const mine of clipsOf.values()) expect(new Set(mine).size).toBe(ROUNDS);
    expect(
      fin.every(
        (s: RoomSnapshot) => s.players.find((p) => p.id === ann.playerId)!.totalScore === 100,
      ),
    ).toBe(true);

    // no unexpected errors (SELF_VOTE was provoked on purpose)
    for (const c of all) expect(c.errors().filter((e) => e.code !== 'SELF_VOTE')).toEqual([]);

    // back to lobby
    ann.send({ t: 'backToLobby' });
    const lobby = await cid.state((s) => s.phase === 'LOBBY');
    expect(lobby.players.every((p) => p.totalScore === 0)).toBe(true);
    expect(lobby.clipCount).toBe(3);
  });
});
