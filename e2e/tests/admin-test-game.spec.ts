import { expect, test } from '@playwright/test';
import { closeAll, newPlayer, readyUp } from './helpers';

// v1.2 #46: /admin "Start test game" (ADMIN_DEV=1 from loopback in serve.sh): the admin hosts a
// private room with 3 server bots that send snippets cut from the official library, then plays
// it to FINAL (analytics/Elo exclusion is covered by server/test/testRoom.test.ts).
// v1.2 #47: bots talk in the lobby (`botVoice`, speaking bars) and dub 3–8 s snippets.
// #53: "Start right away" (default on): no Ready/Start clicks, the game begins once the admin's
// mic passed the check.
test('admin test game: auto start goes straight to DUBBING', async ({ browser }) => {
  const admin = await newPlayer(browser, 'Admin');
  try {
    const { page } = admin;
    await page.goto('/admin');
    const card = page.getByTestId('test-game-card');
    await expect(card.getByTestId('test-game-autostart')).toBeChecked();
    await card.getByTestId('test-game-bots').fill('2');
    await card.getByTestId('test-game-seconds').fill('8');
    const t0 = Date.now();
    await card.getByTestId('test-game-start').click();
    await page.waitForURL(/\/r\/[A-Z0-9]{6}$/);
    // No ready-toggle / start-game clicks anywhere in this test.
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 15_000 });
    test.info().annotations.push({ type: 'click→editor ms', description: String(Date.now() - t0) });
    await expect(page.getByTestId('round-badge')).toHaveText(/Round 1\/1/);
  } finally {
    await closeAll([admin]);
  }
});

test('admin test game: 3 bots, short dubbing, plays to FINAL', async ({ browser }) => {
  test.setTimeout(150_000); // lobby voice + showcase speaking checks wait on real timers
  const admin = await newPlayer(browser, 'Admin');
  try {
    const { page } = admin;
    // Every chunk of every showcased dub (the bots' ones are the only non-empty dubs).
    const chunkMs = new Map<string, number>();
    page.on('websocket', (ws) =>
      ws.on('framereceived', ({ payload }) => {
        if (typeof payload !== 'string' || !payload.includes('"showcase"')) return;
        try {
          const m = JSON.parse(payload) as {
            t: string;
            state?: { showcase?: { chunks: { id: string; durationMs: number }[] } | null };
          };
          for (const c of m.state?.showcase?.chunks ?? []) chunkMs.set(c.id, c.durationMs);
        } catch {
          /* not JSON */
        }
      }),
    );
    await page.goto('/admin');
    const card = page.getByTestId('test-game-card');
    await expect(card).toBeVisible();
    // Default: the normal 210 s, with quick presets; custom values go down to 5 s.
    await expect(card.getByTestId('test-game-seconds')).toHaveValue('210');
    await card.getByTestId('test-game-seconds-30').click();
    await expect(card.getByTestId('test-game-seconds')).toHaveValue('30');
    await card.getByTestId('test-game-bots').fill('3');
    await card.getByTestId('test-game-rounds').fill('1');
    await card.getByTestId('test-game-seconds').fill('8');
    // Manual start (autoStart off): the lobby with ready/start, bot lobby voice.
    await card.getByTestId('test-game-autostart').uncheck();
    await card.getByTestId('test-game-start').click();

    await page.waitForURL(/\/r\/[A-Z0-9]{6}$/);
    const code = new URL(page.url()).pathname.split('/').pop()!;
    expect(await page.evaluate((c) => localStorage.getItem(`dub.token.${c}`), code)).toBeTruthy();
    await expect(page.getByTestId('lobby')).toBeVisible();
    await expect(page.getByTestId('bot-badge')).toHaveCount(3);
    await expect(page.getByTestId('bot-controls')).toBeVisible();
    await expect(page.getByTestId('setting-time')).toHaveText('0:08');
    await expect(page.locator('[data-testid=player-card][data-ready=true]')).toHaveCount(3);

    // Bots talk in the lobby: at least one line played, and a bot card's bars move.
    const botVoices = page.getByTestId('voice-audio');
    await expect
      .poll(async () => Number((await botVoices.getAttribute('data-bot-voices')) ?? 0), {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    await expect(
      page.locator(
        '[data-testid=player-card]:has([data-testid=bot-badge]) [data-testid=voice-speaking][data-speaking=true]',
      ),
    ).not.toHaveCount(0, { timeout: 30_000 });

    await readyUp(admin);
    await expect(page.getByTestId('start-game')).toBeEnabled();
    await page.getByTestId('start-game').click();
    await expect(page.getByTestId('editor')).toBeVisible();
    await page.getByTestId('done').click();

    // All three bots "spoke" (library snippets), so there are three dubs to vote on.
    await expect(page.locator('[data-testid=showcase] h2')).toContainText('of 3', {
      timeout: 30_000,
    });
    // #51: the showcase lists everyone in voice (bots included, author stays anonymous) and
    // lights a chip up while that player talks (here: our own fake-mic beep).
    const strip = page.getByTestId('speaking-strip');
    await expect(strip.getByTestId('speaking-strip-player')).toHaveCount(4);
    await expect(strip.locator('[data-testid=speaking-strip-player][data-bot=true]')).toHaveCount(
      3,
    );
    await expect(
      strip.locator('[data-testid=speaking-strip-player][data-speaking=true]'),
    ).not.toHaveCount(0, { timeout: 20_000 });
    // Vote until the game ends.
    const final = page.getByTestId('final');
    await expect(async () => {
      if (await final.isVisible()) return;
      const pick = page.getByTestId('vote-pick-7');
      // Short click timeout: a pick that turns disabled (vote locked) must not stall the loop.
      if (await pick.isVisible()) await pick.click({ timeout: 1000 }).catch(() => {});
      throw new Error('not final yet');
    }).toPass({ timeout: 90_000, intervals: [500, 1000] });
    await expect(page.getByTestId('final-standings').locator('li')).toHaveCount(4);
    // Bot dubs are made of long snippets (3–8 s, capped at the 8 s fixture clip).
    expect(chunkMs.size).toBeGreaterThanOrEqual(9); // 3 bots × at least 3 chunks
    for (const ms of chunkMs.values()) expect(ms).toBeGreaterThanOrEqual(3000);
  } finally {
    await closeAll([admin]);
  }
});
