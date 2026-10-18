import { expect, test } from '@playwright/test';
import {
  closeAll,
  homeWithName,
  newPlayer,
  peerConnectionCount,
  peerStates,
  readyUp,
  recordOneTake,
  type Player,
} from './helpers';

// V08 + V09 + V13: three strangers queue, get matched, pass the ready check (READY_CHECK_MS in
// serve.sh) and play 3 rounds. Voice is opt-in: no RTCPeerConnection before anyone opts in.
test('random game: queue → match → ready check → 3 rounds → final with Elo', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const players: Player[] = [];
  try {
    for (const name of ['Ann', 'Ben', 'Cat']) players.push(await newPlayer(browser, name));
    const [a, b, c] = players as [Player, Player, Player];
    await Promise.all(players.map(homeWithName));
    await Promise.all(players.map((p) => p.page.getByTestId('random-game').click()));

    // ---- matched into one public room ----
    for (const p of players) await p.page.waitForURL(/\/r\/[A-Z0-9]+$/);
    const codes = new Set(players.map((p) => new URL(p.page.url()).pathname));
    expect(codes.size, [...codes].join(' ')).toBe(1);
    for (const p of players) {
      await expect(p.page.getByTestId('public-lobby')).toBeVisible();
      await expect(p.page.getByTestId('public-voice-state')).toContainText('Voice is off');
      await expect(p.page.getByTestId('public-talk')).toHaveAttribute('aria-pressed', 'false');
    }

    await Promise.all(players.map(readyUp));

    // ---- 3 rounds; only Ann dubs in round 1, so the standings (and Elo) are decided ----
    for (let round = 1; round <= 3; round++) {
      for (const p of players) {
        await expect(p.page.getByTestId('round-badge')).toHaveText(`Round ${round}/3`, {
          timeout: 30_000,
        });
        await expect(p.page.getByTestId('editor')).toBeVisible();
      }
      if (round === 1) await recordOneTake(a);
      await Promise.all(players.map((p) => p.page.getByTestId('done').click()));
      if (round === 1) {
        for (const p of [b, c]) {
          await expect(p.page.getByTestId('showcase-status')).toHaveAttribute(
            'data-status',
            'PLAYING',
            { timeout: 30_000 },
          );
          await p.page.getByTestId('vote-pick-9').click();
          await expect(p.page.getByTestId('vote-ack')).toContainText('9');
        }
      }
    }

    // ---- final: rating change, still no peer connections ----
    for (const p of players) {
      await expect(p.page.getByTestId('final')).toBeVisible({ timeout: 30_000 });
      await expect(p.page.getByTestId('elo-change')).toBeVisible();
    }
    await expect(a.page.getByTestId('elo-change')).toContainText('(+');
    for (const p of players) expect(await peerConnectionCount(p), p.name).toBe(0);

    // ---- opt-in: Ann + Ben talk and connect; Cat never opted in, so nobody connects to her ----
    await a.page.getByTestId('public-talk').click();
    await b.page.getByTestId('public-listen').click();
    for (const p of [a, b]) {
      await expect
        .poll(() => peerStates(p), { timeout: 20_000, message: p.name })
        .toEqual(['connected']);
    }
    expect(await peerConnectionCount(c)).toBe(0);
  } finally {
    await closeAll(players);
  }
});
