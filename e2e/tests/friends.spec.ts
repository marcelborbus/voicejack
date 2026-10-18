import { expect, test } from '@playwright/test';
import {
  closeAll,
  createRoom,
  joinViaInvite,
  newPlayer,
  readyUp,
  renameAccount,
  setExtendedSettings,
  signIn,
  testEmail,
  type Player,
} from './helpers';

/** The dock keeps its open state while a chat hides it, so only click when closed. */
async function openDock(p: Player) {
  const dock = p.page.getByTestId('friends-dock');
  await expect(dock).toBeVisible();
  if ((await dock.getAttribute('aria-expanded')) !== 'true') await dock.click();
  await expect(dock).toHaveAttribute('aria-expanded', 'true');
}

// V10: two registered players finish a private game, become friends from Final, chat live,
// and one invites the other to a room.
test('friends: add from Final → accept → live DM → invite card', async ({ browser }) => {
  test.setTimeout(120_000);
  const players: Player[] = [];
  try {
    for (const name of ['Fay', 'Gus']) players.push(await newPlayer(browser, name));
    const [fay, gus] = players as [Player, Player];
    for (const p of players) {
      await p.page.goto('/');
      await signIn(p, testEmail(p.name.toLowerCase()));
      await renameAccount(p, p.name);
    }

    // ---- a short private game: nobody dubs, so it runs straight to Final ----
    const code = await createRoom(fay);
    await setExtendedSettings(fay, 5);
    await joinViaInvite(gus, code);
    await Promise.all(players.map(readyUp));
    await fay.page.getByTestId('start-game').click();
    for (const p of players) await expect(p.page.getByTestId('editor')).toBeVisible();
    await Promise.all(players.map((p) => p.page.getByTestId('done').click()));
    for (const p of players) await expect(p.page.getByTestId('final')).toBeVisible();

    // ---- Fay adds Gus from Final; Gus accepts from the friends dock ----
    const gusRow = fay.page.getByTestId('final-standings').locator('li', { hasText: 'Gus' });
    await gusRow.getByTestId('add-friend').click();
    await expect(gusRow).toContainText('Requested');

    await openDock(gus);
    const req = gus.page.getByTestId('friend-request').filter({ hasText: 'Fay' });
    await expect(req).toContainText('wants to be friends');
    await req.getByRole('button', { name: 'Accept' }).click();
    await expect(gus.page.getByTestId('friend-row').filter({ hasText: 'Fay' })).toBeVisible();
    await expect(gusRow.getByTestId('is-friend')).toBeVisible();

    // ---- live DM: Gus has the chat open, Fay sends ----
    await gus.page.getByRole('button', { name: 'Chat with Fay' }).click();
    await expect(gus.page.getByTestId('chat-drawer')).toBeVisible();
    await openDock(fay);
    await fay.page.getByRole('button', { name: 'Chat with Gus' }).click();
    await fay.page.getByTestId('dm-input').fill('gg, rematch?');
    await fay.page.getByTestId('dm-input').press('Enter');
    await expect(gus.page.getByTestId('chat-drawer')).toContainText('gg, rematch?');
    await fay.page.getByRole('button', { name: 'Close chat' }).click();
    await gus.page.getByRole('button', { name: 'Close chat' }).click();

    // ---- invite: Fay is back in her lobby and invites Gus, who is on the home page ----
    await gus.page.goto('/');
    await fay.page.getByTestId('back-to-lobby').click();
    await expect(fay.page.getByTestId('lobby')).toBeVisible();
    await openDock(fay);
    await fay.page
      .getByTestId('friend-row')
      .filter({ hasText: 'Gus' })
      .getByTestId('invite-friend')
      .click();
    const card = gus.page.getByTestId('friend-invite');
    await expect(card).toContainText('Fay invites you');
    await card.getByTestId('invite-join').click();
    await expect(gus.page).toHaveURL(new RegExp(`/r/${code}$`));
  } finally {
    await closeAll(players);
  }
});
