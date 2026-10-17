import { expect, test } from '@playwright/test';
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

test('reload during DUBBING keeps the uploaded chunk', async ({ browser }) => {
  const players: Player[] = [];
  try {
    for (const name of ['Host', 'Guest']) players.push(await newPlayer(browser, name));
    const [host, guest] = players as [Player, Player];
    const code = await createRoom(host);
    await setExtendedSettings(host, 45);
    await joinViaInvite(guest, code);
    await Promise.all(players.map(readyUp));
    await host.page.getByTestId('start-game').click();

    await recordOneTake(guest);
    const block = guest.page.getByTestId('chunk-block');
    const before = await block.evaluate((el) => (el as HTMLElement).style.left);

    await guest.page.reload();
    await expect(guest.page.getByTestId('editor')).toBeVisible();
    await expect(guest.page.locator('[data-testid=upload-status][data-state=saved]')).toBeVisible();
    await expect(block).toHaveCount(1);
    await expect(block).toHaveAttribute('data-status', 'uploaded');
    expect(await block.evaluate((el) => (el as HTMLElement).style.left)).toBe(before);
  } finally {
    await closeAll(players);
  }
});
