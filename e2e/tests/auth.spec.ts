import { expect, test } from '@playwright/test';
import { closeAll, newPlayer, renameAccount, signIn, testEmail } from './helpers';

// V04 magic link: guest → sign in → account menu → rename → sign out.
test('guest signs in by magic link, renames, signs out', async ({ browser }) => {
  const p = await newPlayer(browser, 'Auth');
  try {
    const { page } = p;
    await page.goto('/');
    await expect(page.getByTestId('signin-button')).toBeVisible();
    const email = testEmail('auth');
    await signIn(p, email);

    await page.getByTestId('account-button').click();
    await expect(page.getByTestId('account-dialog')).toContainText(email);
    await page.getByTestId('account-dialog').getByRole('button', { name: 'Close' }).click();

    await renameAccount(p, 'Renamed');
    await page.reload();
    await expect(page.getByTestId('account-button')).toContainText('Renamed');
    // #40: the face fills its mug (the button's icon sizing used to shrink it to 16 px).
    const fill = await page
      .getByTestId('account-button')
      .locator('.mug')
      .evaluate((m) => m.querySelector('svg')!.getBoundingClientRect().width / m.clientWidth);
    expect(fill).toBeGreaterThan(0.9);

    // #41: the account name is the default (over a stale last-room name in this browser); a
    // different name is for that room only and doesn't rename the account.
    await page.evaluate(() => localStorage.setItem('dub.name', 'Stale'));
    await page.reload();
    await page.getByTestId('tab-create').click();
    await expect(page.getByTestId('name-input')).toHaveValue('Renamed');
    await page.getByTestId('name-input').fill('Party Name');
    await expect(page.getByTestId('room-only-name-hint')).toContainText('Renamed');
    await page.getByTestId('create-room').click();
    await expect(page.getByTestId('lobby')).toBeVisible();
    await page.goto('/');
    await expect(page.getByTestId('account-button')).toContainText('Renamed');
    await page.getByTestId('tab-create').click();
    await expect(page.getByTestId('name-input')).toHaveValue('Renamed');

    await page.getByTestId('account-button').click();
    await page.getByTestId('account-dialog').getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByTestId('signin-button')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('signin-button')).toBeVisible();
  } finally {
    await closeAll([p]);
  }
});
