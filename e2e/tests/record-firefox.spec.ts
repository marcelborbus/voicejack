import { expect, test, type Page } from '@playwright/test';
import { closeAll, newPlayer, type Player } from './helpers';

// #49: pressing record in the editor of an admin test game (3 bots) froze Firefox: the
// recording UI cost Firefox most of its frames (infinite ping/pulse animations over 120 px
// blurred glows, a resizing block with a blurred shadow, a canvas resized every frame).
// Runs in the `firefox` project only (playwright.config.ts).

/** Main-thread heartbeat (50 ms interval) and rAF frame counter, installed before load. */
function installProbes() {
  const w = window as unknown as Record<string, number>;
  w.__hb = Date.now();
  w.__maxHbGap = 0;
  setInterval(() => {
    const n = Date.now();
    w.__maxHbGap = Math.max(w.__maxHbGap!, n - w.__hb!);
    w.__hb = n;
  }, 50);
}

/** Frames per second over `ms`, or null if the page did not answer within `ms + 3 s` (hung). */
async function measureFps(page: Page, ms: number): Promise<{ fps: number; maxGap: number } | null> {
  const probe = page.evaluate(async (span) => {
    let n = 0;
    let max = 0;
    const t0 = performance.now();
    let last = t0;
    await new Promise<void>((done) => {
      const f = (t: number) => {
        n++;
        max = Math.max(max, t - last);
        last = t;
        if (t - t0 < span) requestAnimationFrame(f);
        else done();
      };
      requestAnimationFrame(f);
    });
    return { fps: (n * 1000) / span, maxGap: max };
  }, ms);
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), ms + 3000));
  return Promise.race([probe, timeout]);
}

async function recordTake(p: Player, n: number, check: (label: string) => Promise<void>) {
  const { page } = p;
  await expect(page.getByTestId('record')).toBeEnabled();
  await page.locator('body').press('r');
  await expect(page.getByTestId('recording-block')).toBeVisible();
  await check(`take ${n}`);
  await page.locator('body').press('r');
  await expect(page.getByTestId('chunk-block')).toHaveCount(n);
  await expect(page.locator('[data-testid=chunk-block][data-status=uploaded]')).toHaveCount(n);
}

test('firefox: admin test game, record 2 takes, Done, showcase', async ({ browser }) => {
  const admin = await newPlayer(browser, 'Admin');
  try {
    const { page } = admin;
    await admin.context.addInitScript(installProbes);
    await page.goto('/admin');
    const card = page.getByTestId('test-game-card');
    await card.getByTestId('test-game-bots').fill('3');
    await card.getByTestId('test-game-rounds').fill('1');
    await card.getByTestId('test-game-seconds').fill('60');
    await card.getByTestId('test-game-start').click();
    await page.waitForURL(/\/r\/[A-Z0-9]{6}$/);
    // #53: "Start right away" (default): no ready/start clicks, the editor comes up by itself.
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 20_000 });
    // Let the clip load before the first take.
    await expect
      .poll(() => page.evaluate(() => document.querySelector('video')?.readyState ?? 0))
      .toBeGreaterThanOrEqual(3);

    const check = async (label: string) => {
      await page.evaluate(() => ((window as unknown as Record<string, number>).__maxHbGap = 0));
      const r = await measureFps(page, 2500);
      expect(r, `${label}: page stopped answering while recording`).not.toBeNull();
      const hb = await page.evaluate(
        () => (window as unknown as Record<string, number>).__maxHbGap,
      );
      console.log(
        `[firefox] ${label}: ${r!.fps.toFixed(0)} fps, max frame gap ${r!.maxGap.toFixed(0)} ms, max heartbeat gap ${hb} ms`,
      );
      // Before the fix: 4–10 fps (mostly ~5) with 300–530 ms frame gaps at this window size;
      // after: 30–40 fps alone, 20+ next to a parallel worker.
      expect(hb, `${label}: main thread blocked`).toBeLessThan(1000);
      expect(r!.fps, `${label}: frame rate collapsed while recording`).toBeGreaterThan(12);
    };

    await recordTake(admin, 1, check);
    // Second take from the start again: it is layered over the first one (second lane).
    await page.locator('body').press('Home');
    await recordTake(admin, 2, check);
    await expect(page.locator('[data-testid=upload-status][data-state=saved]')).toBeVisible();

    await page.getByTestId('done').click();
    await expect(page.getByTestId('showcase')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-testid=showcase] h2')).toContainText('of 4');
    // #51: every player in voice is listed next to the vote panel, bots included.
    await expect(page.getByTestId('speaking-strip-player')).toHaveCount(4);
  } finally {
    await closeAll([admin]);
  }
});
