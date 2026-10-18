import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export interface Player {
  name: string;
  context: BrowserContext;
  page: Page;
}

/** Collects every RTCPeerConnection in `window.__pcs` (voice checks). */
function trackPeerConnections() {
  const Orig = window.RTCPeerConnection;
  if (!Orig) return;
  const pcs: RTCPeerConnection[] = [];
  (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = pcs;
  class Tracked extends Orig {
    constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
      super(...args);
      pcs.push(this);
    }
  }
  window.RTCPeerConnection = Tracked as typeof RTCPeerConnection;
}

/**
 * Logs each distinct `showcase-status` value in `window.__showcaseLog` (LOCKED only lasts
 * betweenItemsMs = 200 ms with TIMINGS=fast, too short to poll for reliably).
 */
function trackShowcaseStatus() {
  const log: string[] = [];
  (window as unknown as { __showcaseLog: string[] }).__showcaseLog = log;
  let last = '';
  new MutationObserver(() => {
    const el = document.querySelector('[data-testid=showcase-status]');
    const h2 = document.querySelector('[data-testid=showcase] h2');
    if (!el) return;
    const v = `${h2?.textContent ?? ''}:${el.getAttribute('data-status')}`;
    if (v !== last) log.push((last = v));
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
}

/** What the round-results screen showed (it only lasts 1 s with TIMINGS=fast). */
export interface ResultsSeen {
  entries: number;
  clips: string[];
}

/**
 * Records the last state of the round-results list in `window.__resultsSeen`: the entry count
 * and the clip title of each entry (V14). Survives the move on to FINAL.
 */
function trackRoundResults() {
  const w = window as unknown as { __resultsSeen: ResultsSeen | null };
  w.__resultsSeen = null;
  new MutationObserver(() => {
    const list = document.querySelector('[data-testid=results-list]');
    if (!list) return;
    const entries = list.querySelectorAll('[data-testid=result-entry]').length;
    const clips = [...list.querySelectorAll('[data-testid=result-clip]')].map(
      (e) => e.textContent ?? '',
    );
    w.__resultsSeen = { entries, clips };
  }).observe(document, { subtree: true, childList: true, characterData: true });
}

/** Waits until the round-results screen has been seen with `entries` entries. */
export async function roundResultsSeen(p: Player, entries: number): Promise<ResultsSeen> {
  const handle = await p.page.waitForFunction((n) => {
    const r = (window as unknown as { __resultsSeen: ResultsSeen | null }).__resultsSeen;
    return r && r.entries === n ? r : null;
  }, entries);
  return (await handle.jsonValue()) as ResultsSeen;
}

export async function newPlayer(browser: Browser, name: string): Promise<Player> {
  const context = await browser.newContext();
  await context.addInitScript(trackPeerConnections);
  await context.addInitScript(trackShowcaseStatus);
  await context.addInitScript(trackRoundResults);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror: ${e.message}`));
  return { name, context, page };
}

export async function closeAll(players: Player[]) {
  await Promise.all(players.map((p) => p.context.close()));
}

/** Home → "Start a party" → lobby. Returns the room code. */
export async function createRoom(p: Player): Promise<string> {
  await p.page.goto('/');
  await p.page.getByTestId('tab-create').click();
  await p.page.getByTestId('name-input').fill(p.name);
  await p.page.getByTestId('create-room').click();
  await p.page.waitForURL(/\/r\/[A-Z0-9]+$/);
  await expect(p.page.getByTestId('lobby')).toBeVisible();
  return new URL(p.page.url()).pathname.split('/').pop()!;
}

/** Opens the invite link and answers the name prompt. */
export async function joinViaInvite(p: Player, code: string) {
  await p.page.goto(`/r/${code}`);
  await p.page.getByTestId('room-name-input').fill(p.name);
  await p.page.getByTestId('room-join').click();
  await expect(p.page.getByTestId('lobby')).toBeVisible();
}

/** Host: Extended mode, 1 round, `seconds` of dubbing. */
export async function setExtendedSettings(host: Player, seconds: number) {
  const { page } = host;
  await page.getByTestId('mode-switch').click();
  await expect(page.getByTestId('mode-switch')).toHaveAttribute('aria-checked', 'true');
  const thumb = page.getByTestId('rounds-slider').getByRole('slider');
  await thumb.focus();
  await thumb.press('Home');
  await expect(page.getByTestId('setting-rounds')).toHaveText('1');
  const secs = page.getByTestId('dubbing-seconds-input');
  await secs.fill(String(seconds));
  await secs.press('Enter');
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  await expect(page.getByTestId('setting-time')).toHaveText(clock);
}

/** Mic check passes on the fake beep, then the ready toggle. */
export async function readyUp(p: Player) {
  const { page } = p;
  const panel = page.locator('[data-testid=mic-check-panel][data-mic-ok=true]');
  await expect(async () => {
    if (await panel.isVisible()) return;
    const btn = page.getByTestId('mic-check');
    if (await btn.isVisible()) await btn.click();
    throw new Error('mic not ok yet');
  }).toPass({ timeout: 20_000, intervals: [250, 500, 1000] });
  const toggle = page.getByTestId('ready-toggle');
  await expect(toggle).toBeEnabled();
  await toggle.click();
  // Public rooms start the moment the last player is ready, so the toggle may vanish at once.
  await expect(
    page.locator('[data-testid=ready-toggle][aria-pressed=true]').or(page.getByTestId('editor')),
  ).toBeVisible();
}

/** In the editor: R, ~2 s, R; waits until the take is uploaded and saved. */
export async function recordOneTake(p: Player) {
  const { page } = p;
  await expect(page.getByTestId('editor')).toBeVisible();
  await expect(page.getByTestId('record')).toBeEnabled();
  const before = await page.getByTestId('chunk-block').count();
  await page.locator('body').press('r');
  await expect(page.getByTestId('recording-block')).toBeVisible();
  await page.waitForTimeout(2000);
  await page.locator('body').press('r');
  await expect(page.getByTestId('chunk-block')).toHaveCount(before + 1);
  await expect(page.locator('[data-testid=chunk-block][data-status=uploaded]')).toHaveCount(
    before + 1,
  );
  await expect(page.locator('[data-testid=upload-status][data-state=saved]')).toBeVisible();
}

/** Number of RTCPeerConnections this page has created (see `trackPeerConnections`). */
export async function peerConnectionCount(p: Player): Promise<number> {
  return p.page.evaluate(
    () => (window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs?.length ?? 0,
  );
}

/** Home page with the name field filled in (Create tab). */
export async function homeWithName(p: Player) {
  await p.page.goto('/');
  await p.page.getByTestId('tab-create').click();
  await p.page.getByTestId('name-input').fill(p.name);
}

/** Unique per run, so reruns against the same server never hit the per-address limit. */
export function testEmail(tag: string): string {
  return `${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@example.org`;
}

/**
 * Magic-link sign-in (V04) through the UI. The link comes from the server's test outbox
 * (`MAIL_TRANSPORT=log` + `TIMINGS=fast` only, see serve.sh).
 */
export async function signIn(p: Player, email: string) {
  const { page } = p;
  if (!page.url().startsWith('http')) await page.goto('/');
  await page.getByTestId('signin-button').click();
  const dialog = page.getByTestId('signin-dialog');
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByRole('button', { name: 'Email me a link' }).click();
  await expect(dialog).toContainText('Check your inbox');
  let link = '';
  await expect(async () => {
    const r = await page.request.get(`/api/test/outbox?to=${encodeURIComponent(email)}`);
    const { text } = (await r.json()) as { text: string | null };
    const m = text?.match(/https?:\/\/\S+\/api\/auth\/verify\?t=[\w%-]+/);
    expect(m, 'magic link in the outbox').toBeTruthy();
    link = m![0];
  }).toPass({ timeout: 10_000 });
  await page.goto(link);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/api/'));
  await expect(page.getByTestId('account-button')).toBeVisible();
}

/** Account dialog → display name → Save. */
export async function renameAccount(p: Player, name: string) {
  const { page } = p;
  await page.getByTestId('account-button').click();
  const dialog = page.getByTestId('account-dialog');
  await dialog.getByLabel('Display name').fill(name);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('account-button')).toContainText(name);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
}

/** `connectionState` of each RTCPeerConnection this page created. */
export async function peerStates(p: Player): Promise<string[]> {
  return p.page.evaluate(() =>
    ((window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? []).map(
      (pc) => pc.connectionState,
    ),
  );
}
