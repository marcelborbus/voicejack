import { expect, test } from '@playwright/test';
import { closeAll, createRoom, newPlayer, readyUp, setExtendedSettings } from './helpers';

// Fast smoke (V01): one browser, two server-side bots (serve.sh runs with DEV_BOTS=1).
test('solo host + 2 bots: lobby → dub → vote → final', async ({ browser }) => {
  const host = await newPlayer(browser, 'Solo');
  try {
    await createRoom(host);
    const { page } = host;
    await setExtendedSettings(host, 15);
    await expect(page.getByTestId('bot-controls')).toBeVisible();
    await page.getByTestId('add-bot').click();
    await page.getByTestId('add-bot').click();
    await page.getByTestId('add-bot').click();
    await page.getByTestId('remove-bot').click();
    await expect(page.getByTestId('bot-count')).toHaveText('2/7');
    await expect(page.getByTestId('bot-badge')).toHaveCount(2);
    await expect(page.locator('[data-testid=player-card][data-ready=true]')).toHaveCount(2);
    await readyUp(host);
    await expect(page.getByTestId('start-game')).toBeEnabled();
    await page.getByTestId('start-game').click();

    await expect(page.getByTestId('editor')).toBeVisible();
    await page.getByTestId('done').click();

    // Two bot dubs; the human's is empty and not showcased.
    for (let i = 1; i <= 2; i++) {
      await expect(page.locator('[data-testid=showcase] h2')).toContainText(`Dub ${i} of 2`, {
        timeout: 30_000,
      });
      await expect(page.getByTestId('showcase-status')).toHaveAttribute('data-status', 'PLAYING');
      await page.getByTestId('vote-pick-7').click();
      await expect(page.getByTestId('vote-ack')).toContainText('7');
    }

    await expect(page.getByTestId('final')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('final-standings').locator('li')).toHaveCount(3);

    // V15: one-tap mood + optional comment on Final, visible in the admin analytics (ADMIN_DEV).
    const comment = `bots e2e ${Date.now()}`;
    await expect(page.getByTestId('mood-prompt')).toBeVisible();
    await page.getByTestId('mood-2').click();
    await page.getByTestId('mood-comment').fill(comment);
    await page.getByTestId('mood-send').click();
    await expect(page.getByTestId('mood-thanks')).toBeVisible();
    await expect
      .poll(
        async () => {
          const res = await page.request.get('/api/admin/analytics?status=all');
          expect(res.ok()).toBe(true);
          const body = (await res.json()) as {
            feedback: { items: { comment: string; mood: number; context: { phase?: string } }[] };
          };
          return body.feedback.items.find((f) => f.comment === comment) ?? null;
        },
        { timeout: 10_000 },
      )
      .toMatchObject({ mood: 2, context: { phase: 'FINAL' } });
  } finally {
    await closeAll([host]);
  }
});
