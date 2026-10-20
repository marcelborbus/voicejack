import { expect, test, type Page } from '@playwright/test';
import {
  closeAll,
  createRoom,
  joinViaInvite,
  newPlayer,
  readyUp,
  recordOneTake,
  setExtendedSettings,
  type Player,
} from './helpers';

// #48 voice effects, in Chromium and Firefox (both projects run this file): record a take,
// give it 🤖, reload (the effect comes back from the server manifest), the showcase badge shows
// 🤖, and the audio actually played is the processed render, not the dry take.

interface FxStat {
  chunkId: string;
  fx: string;
  rms: number;
  dryRms: number;
  hash: string;
  dryHash: string;
  peak: number;
  renderMs: number;
  worklet: boolean;
}

const stats = (page: Page) =>
  page.evaluate(() => (window as unknown as { __vjFx: { stats(): FxStat[] } }).__vjFx.stats());

async function robotStat(page: Page, chunkId: string): Promise<FxStat> {
  let found: FxStat | undefined;
  await expect
    .poll(async () => {
      found = (await stats(page)).find((s) => s.chunkId === chunkId && s.fx === 'robot');
      return !!found;
    })
    .toBe(true);
  return found!;
}

function expectProcessed(s: FxStat) {
  expect(s.hash).not.toBe(s.dryHash);
  expect(s.rms).toBeGreaterThan(0);
  expect(s.peak).toBeLessThanOrEqual(1);
  expect(s.worklet).toBe(true);
}

test('fx: record, robot, reload keeps it, showcase badge, processed audio', async ({ browser }) => {
  // Two humans, not a bot game: while the dubber reloads, the other player keeps the phase
  // open (a bot is done at once, and "everyone connected is done" would end DUBBING).
  const players: Player[] = [];
  try {
    for (const name of ['Host', 'Dubber']) players.push(await newPlayer(browser, name));
    const [host, admin] = players as [Player, Player];
    const code = await createRoom(host);
    await setExtendedSettings(host, 60);
    await joinViaInvite(admin, code);
    await Promise.all(players.map(readyUp));
    await host.page.getByTestId('start-game').click();
    const { page } = admin;
    await expect(page.getByTestId('editor')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.querySelector('video')?.readyState ?? 0))
      .toBeGreaterThanOrEqual(3);

    await recordOneTake(admin);
    const block = page.getByTestId('chunk-block');
    await expect(block).toHaveAttribute('data-selected', 'true'); // a new take is selected
    const chunkId = (await block.getAttribute('data-chunk-id'))!;

    // E opens the picker; the 🤖 tile applies to the selected take (and previews it).
    await page.locator('body').press('e');
    await expect(page.getByTestId('fx-picker')).toBeVisible();
    await page.getByTestId('fx-robot').click();
    await expect(page.getByTestId('fx-robot')).toHaveAttribute('aria-pressed', 'true');
    await expect(block).toHaveAttribute('data-fx', 'robot');
    await expect(block.getByTestId('chunk-fx')).toHaveText('🤖');
    await page.locator('body').press('Escape');
    await expect(page.getByTestId('fx-picker')).toBeHidden();
    expectProcessed(await robotStat(page, chunkId));

    // Shift+E cycles to the next effect and back is just more presses; check one step.
    await page.locator('body').press('Shift+E');
    await expect(block).not.toHaveAttribute('data-fx', 'robot');
    // …and back to robot via the picker, then let the manifest reach the server.
    await page.locator('body').press('e');
    await page.getByTestId('fx-robot').click();
    await page.locator('body').press('Escape');
    await expect(block).toHaveAttribute('data-fx', 'robot');
    await page.waitForTimeout(500);

    await page.reload();
    await expect(page.getByTestId('editor')).toBeVisible();
    await expect(block).toHaveCount(1);
    await expect(block).toHaveAttribute('data-status', 'uploaded');
    await expect(block).toHaveAttribute('data-fx', 'robot');
    await expect(block.getByTestId('chunk-fx')).toHaveText('🤖');
    expectProcessed(await robotStat(page, chunkId));

    await page.getByTestId('done').click();
    await host.page.getByTestId('done').click();
    // Only the dubber's dub is shown (the host's is empty).
    await expect(page.getByTestId('showcase')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Your dub')).toBeVisible();
    await expect(page.getByTestId('fx-badge')).toHaveText(/🤖/);
    expectProcessed(await robotStat(page, chunkId));
    // The other player hears the same effect, rendered on their side from the manifest.
    await expect(host.page.getByTestId('fx-badge')).toHaveText(/🤖/);
    expectProcessed(await robotStat(host.page, chunkId));
  } finally {
    await closeAll(players);
  }
});
