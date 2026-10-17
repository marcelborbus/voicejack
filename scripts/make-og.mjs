#!/usr/bin/env node
// Renders the social preview image (client/public/og.png, 1200×630) and the
// apple-touch-icon (client/public/apple-touch-icon.png, 180×180) with Playwright Chromium.
// The outputs are committed; re-run after brand changes:  node scripts/make-og.mjs
// (Node ≥ 24 strips the types from client/src/lib/avatar.ts on import.)
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { avatarSvg } from '../client/src/lib/avatar.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'client/public');
const fonts = pathToFileURL(path.join(root, 'client/node_modules/@fontsource-variable')).href;
const names = ['Captain Mumble', 'Sir Reverb', 'Lil Squeak', 'DJ Kazoo'];

let html = readFileSync(path.join(root, 'scripts/og/og.html'), 'utf8').replaceAll('{{FONTS}}', fonts);
names.forEach((n, i) => (html = html.replace(`{{MUG_${i}}}`, avatarSvg(n))));

const tmp = mkdtempSync(path.join(os.tmpdir(), 'voicejack-og-'));
const file = path.join(tmp, 'og.html');
writeFileSync(file, html);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.goto(pathToFileURL(file).href);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(pub, 'og.png') });

  const icon = await browser.newPage({ viewport: { width: 180, height: 180 } });
  await icon.setContent(
    `<body style="margin:0;width:180px;height:180px;display:grid;place-items:center;background:linear-gradient(120deg,#d946ef,#ec4899,#f97316)">
      <svg viewBox="0 0 24 24" width="120" height="120" fill="none">
        <rect x="8" y="2" width="7" height="11.5" rx="3.5" fill="#fff"/>
        <path d="M4.8 10.6a6.7 6.7 0 0 0 13.4 0" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
        <path d="M11.5 17.4v1.1c0 2.6 3.3 3.2 5.2 1.7" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>
        <path d="M16.6 20.3l2.3-1.7" stroke="#fff" stroke-width="2.8" stroke-linecap="round"/>
        <path d="M19.9 17.9l1.5-1.1" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>
      </svg></body>`,
  );
  await icon.screenshot({ path: path.join(pub, 'apple-touch-icon.png') });
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log('wrote client/public/og.png and client/public/apple-touch-icon.png');
