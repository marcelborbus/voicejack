import { expect, test } from '@playwright/test';
import { closeAll, newPlayer, readyUp } from './helpers';

// v1.2 #46: /admin "Start test game" (ADMIN_DEV=1 from loopback in serve.sh): the admin hosts a
// private room with 3 server bots that send snippets cut from the official library, then plays
// it to FINAL (analytics/Elo exclusion is covered by server/test/testRoom.test.ts).
test('admin test game: 3 bots, short dubbing, plays to FINAL', async ({ browser }) => {
  const admin = await newPlayer(browser, 'Admin');
  try {
    const { page } = admin;
    await page.goto('/admin');
    const card = page.getByTestId('test-game-card');
    await expect(card).toBeVisible();
    await card.getByTestId('test-game-bots').fill('3');
    await card.getByTestId('test-game-rounds').fill('1');
    await card.getByTestId('test-game-seconds').fill('8');
    await card.getByTestId('test-game-start').click();

    await page.waitForURL(/\/r\/[A-Z0-9]{6}$/);
    const code = new URL(page.url()).pathname.split('/').pop()!;
    expect(await page.evaluate((c) => localStorage.getItem(`dub.token.${c}`), code)).toBeTruthy();
    await expect(page.getByTestId('lobby')).toBeVisible();
    await expect(page.getByTestId('bot-badge')).toHaveCount(3);
    await expect(page.getByTestId('bot-controls')).toBeVisible();
    await expect(page.getByTestId('setting-time')).toHaveText('0:08');
    await expect(page.locator('[data-testid=player-card][data-ready=true]')).toHaveCount(3);

    await readyUp(admin);
    await expect(page.getByTestId('start-game')).toBeEnabled();
    await page.getByTestId('start-game').click();
    await expect(page.getByTestId('editor')).toBeVisible();
    await page.getByTestId('done').click();

    // All three bots "spoke" (library snippets), so there are three dubs to vote on.
    await expect(page.locator('[data-testid=showcase] h2')).toContainText('of 3', {
      timeout: 30_000,
    });
    // Vote until the game ends.
    const final = page.getByTestId('final');
    await expect(async () => {
      if (await final.isVisible()) return;
      const pick = page.getByTestId('vote-pick-7');
      if (await pick.isVisible()) await pick.click().catch(() => {});
      throw new Error('not final yet');
    }).toPass({ timeout: 90_000, intervals: [500, 1000] });
    await expect(page.getByTestId('final-standings').locator('li')).toHaveCount(4);
  } finally {
    await closeAll([admin]);
  }
});
