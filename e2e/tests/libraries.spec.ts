import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  closeAll,
  createRoom,
  newPlayer,
  readyUp,
  setExtendedSettings,
  signIn,
  testEmail,
} from './helpers';

/** An 8 s VP9/Opus fixture from make-fixtures.sh; the server normalizes uploads with ffmpeg. */
const FIXTURE = path.join(
  process.env.E2E_TMP ?? path.join(os.tmpdir(), 'voicejack-e2e'),
  'clips/test-a.webm',
);
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

async function newLibrary(page: Page, button: string, name: string) {
  await page.getByTestId(button).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: new RegExp(name) })).toHaveAttribute(
    'aria-current',
    'true',
  );
}

/** #42: "Start here" / "End here" on the preview set the trim fields (clamped, end > start). */
async function markTrim(page: Page, form: string) {
  const f = page.getByTestId(form);
  const video = f.locator('video');
  const seek = (t: number) =>
    video.evaluate(
      (v: HTMLVideoElement, at) =>
        new Promise<void>((resolve) => {
          v.addEventListener('seeked', () => resolve(), { once: true });
          v.currentTime = at;
        }),
      t,
    );
  await seek(1);
  await f.getByTestId('trim-mark-start').click();
  await expect(f.getByLabel('Start (s)')).toHaveValue('1');
  await seek(0.5);
  await f.getByTestId('trim-mark-end').click();
  await expect(f.getByTestId('trim-note')).toContainText('after the start');
  await expect(f.getByLabel('End (s)')).toHaveValue('3');
  await seek(4);
  await f.getByTestId('trim-mark-end').click();
  await expect(f.getByLabel('End (s)')).toHaveValue('4');
  await expect(f.getByTestId('trim-length')).toHaveText('3.0 s');
  await f.getByLabel('End (s)').fill('0.5');
  await expect(f.getByTestId('trim-error')).toBeVisible();
  await expect(f.getByRole('button', { name: 'Upload' })).toBeDisabled();
  await f.getByLabel('End (s)').fill('4');
}

/** Fills an upload form (admin or "My clips") and waits until the clip is normalized. */
async function upload(page: Page, form: string, title: string, extra?: () => Promise<void>) {
  const f = page.getByTestId(form);
  await f.locator('input[type=file]').setInputFiles(FIXTURE);
  await f.getByLabel('Title').fill(title);
  // #42: the end starts at the preview's duration (8 s fixture, ≤ 60 s).
  await expect(f.getByLabel('End (s)')).toHaveValue('8');
  await f.getByLabel('End (s)').fill('3');
  await extra?.();
  await f.getByRole('button', { name: 'Upload' }).click();
  const card = page.getByTestId('admin-clip').filter({ hasText: title });
  await expect(card).toBeVisible();
  await expect(card.getByText('processing')).toBeHidden({ timeout: 45_000 });
  await expect(card.getByText('failed')).toHaveCount(0);
  await expect(card.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
}

// V05 + V06: admin uploads into a new official library; a registered host uploads to
// "My clips", picks that library in the lobby and plays it.
test('libraries: admin upload, host upload, lobby pick, game uses it', async ({ browser }) => {
  test.skip(!hasFfmpeg, 'ffmpeg not available: uploads cannot be normalized');
  test.setTimeout(150_000);
  const host = await newPlayer(browser, 'Hal');
  const { page } = host;
  try {
    // ---- admin (ADMIN_DEV=1 from loopback in serve.sh) ----
    await page.goto('/admin');
    await expect(page.getByTestId('admin-page')).toBeVisible();
    await newLibrary(page, 'admin-new-library', 'E2E Official');
    await upload(page, 'admin-upload', 'Official Tiny', async () => {
      const f = page.getByTestId('admin-upload');
      await f.getByLabel('Author').fill('Voicejack e2e');
      await f.getByLabel('License').fill('CC0 1.0');
      await markTrim(page, 'admin-upload');
    });
    // The server got ss=1, t=3 from "Start here" at 1 s and "End here" at 4 s.
    await expect(
      page.getByTestId('admin-clip').filter({ hasText: 'Official Tiny' }),
    ).toContainText(/0:0[23]/);

    // ---- registered host: two clips in "My clips" (host + 1 bot need 2 different scenes) ----
    await page.goto('/');
    await signIn(host, testEmail('host'));
    await page.getByTestId('account-button').click();
    await page.getByTestId('my-clips-link').click();
    await expect(page.getByTestId('my-library-page')).toBeVisible();
    await newLibrary(page, 'my-new-library', 'My E2E Clips');
    for (const title of ['Mine One', 'Mine Two']) {
      await upload(page, 'my-upload', title, () => page.getByTestId('my-upload-rights').check());
    }

    // ---- lobby: pick the private library, play one round with a bot ----
    await createRoom(host);
    await setExtendedSettings(host, 5);
    await page.getByTestId('library-select').click();
    await page.getByRole('option', { name: /My E2E Clips/ }).click();
    await expect(page.getByTestId('library-select')).toContainText('My E2E Clips');
    await page.getByTestId('add-bot').click();
    await readyUp(host);
    await page.getByTestId('start-game').click();
    await expect(page.getByTestId('editor')).toBeVisible();
    await expect(page.getByTestId('clip-title')).toHaveText(/^Mine (One|Two)$/);
    await page.getByTestId('done').click();
    // The bot's dub plays on the other clip of the private library.
    await expect(page.getByTestId('showcase-status')).toHaveAttribute('data-status', 'PLAYING', {
      timeout: 30_000,
    });
    await expect(page.locator('[data-testid=showcase] .tape')).toContainText(/Mine (One|Two)/);
    await page.getByTestId('vote-pick-8').click();
    await expect(page.getByTestId('final')).toBeVisible({ timeout: 30_000 });
  } finally {
    await closeAll([host]);
  }
});
