import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

/** e2e/fixtures/legal.json, served by the test server via LEGAL_PATH (serve.sh). */
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '../fixtures/legal.json'), 'utf8'),
) as { name: string; email: string };

// V12 + V13: footer links on every page, Impressum from legal.json, anti-scraping.
test('footer links reach the legal pages; the Impressum has no scrapeable email', async ({
  page,
  request,
}) => {
  for (const start of ['/', '/r/ZZZZZZ', '/library']) {
    await page.goto(start);
    await page.getByTestId('footer-impressum').click();
    await expect(page).toHaveURL(/\/impressum$/);
    await expect(page.getByTestId('legal-operator')).toContainText(FIXTURE.name);
  }
  // Humans see the address (joined in the browser), but there is no mailto: link.
  await expect(page.getByTestId('legal-email').first()).toHaveText(FIXTURE.email);
  await expect(page.locator('a[href^="mailto:"]')).toHaveCount(0);
  await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', 'noindex');

  await page.getByTestId('footer-datenschutz').click();
  await expect(page.getByTestId('legal-datenschutz')).toBeVisible();
  await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', 'noindex');
  await page.getByTestId('footer-takedown').click();
  await expect(page.getByTestId('legal-takedown')).toBeVisible();
  await expect(page.getByTestId('takedown-email')).toContainText(FIXTURE.email);

  // Page source (direct load) and the JSON never contain the address.
  for (const url of ['/impressum', '/datenschutz', '/takedown']) {
    const res = await request.get(url);
    expect(res.headers()['x-robots-tag']).toBe('noindex, nofollow');
    const html = await res.text();
    expect(html).toContain('<meta name="robots" content="noindex" />');
    expect(html).not.toContain(FIXTURE.email);
  }
  const api = await request.get('/api/legal');
  expect(api.headers()['x-robots-tag']).toBe('noindex, nofollow');
  const body = await api.text();
  expect(body).not.toContain(FIXTURE.email);
  expect(body).not.toContain('@');
  expect(body).toContain(FIXTURE.name);

  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toContain('Disallow: /api/');
  expect(robots).toContain('Disallow: /impressum');

  // The home page stays indexable.
  await page.goto('/');
  await expect(page.locator('meta[name=robots]')).toHaveCount(0);
});
