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

    await page.getByTestId('account-button').click();
    await page.getByTestId('account-dialog').getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByTestId('signin-button')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('signin-button')).toBeVisible();
  } finally {
    await closeAll([p]);
  }
});
