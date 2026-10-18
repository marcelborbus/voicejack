import { expect, test } from '@playwright/test';
import {
  closeAll,
  createRoom,
  joinViaInvite,
  newPlayer,
  readyUp,
  recordOneTake,
  roundResultsSeen,
  setExtendedSettings,
  type Player,
} from './helpers';

/** Score everyone else gives the dub of players[k]: makes the ranking deterministic. */
const SCORE_FOR_AUTHOR = [10, 6, 2];

test('three players: create → dub → showcase → results → final', async ({ browser }) => {
  const players: Player[] = [];
  try {
    for (const name of ['Alice', 'Bob', 'Cleo']) players.push(await newPlayer(browser, name));
    const [host, ...guests] = players as [Player, Player, Player];

    // ---- lobby ----
    const code = await createRoom(host);
    await setExtendedSettings(host, 15);
    for (const g of guests) await joinViaInvite(g, code);
    await expect(host.page.getByTestId('player-card')).toHaveCount(3);
    await Promise.all(players.map(readyUp));
    const start = host.page.getByTestId('start-game');
    await expect(start).toBeEnabled();
    await start.click();

    // ---- dubbing: voice is off ----
    for (const p of players) {
      await expect(p.page.getByTestId('editor')).toBeVisible();
      await expect(p.page.getByTestId('voice-dock')).toHaveAttribute('data-allowed', 'false');
      await expect(p.page.getByTestId('countdown')).toBeVisible();
    }
    // V14: every player dubs a different scene.
    const titles = await Promise.all(
      players.map((p) => p.page.getByTestId('clip-title').textContent()),
    );
    expect(new Set(titles).size, titles.join(' | ')).toBe(3);
    await Promise.all(
      players.map(async (p) => {
        await recordOneTake(p);
        await p.page.getByTestId('done').click();
        // The last Done ends the phase (+500 ms grace), so the banner may already be gone.
        await expect(
          p.page.getByTestId('done-banner').or(p.page.getByTestId('showcase')),
        ).toBeVisible();
      }),
    );

    // ---- showcase: 3 dubs, each voted by the two others ----
    const sources: string[] = [];
    for (let i = 0; i < 3; i++) {
      for (const p of players) {
        await expect(p.page.locator('[data-testid=showcase] h2')).toContainText(
          `Dub ${i + 1} of 3`,
        );
        await expect(p.page.getByTestId('showcase-status')).toHaveAttribute(
          'data-status',
          'PLAYING',
        );
      }
      if (i === 0) {
        for (const p of players)
          await expect(p.page.getByTestId('voice-dock')).toHaveAttribute('data-allowed', 'true');
      }
      const own = await Promise.all(
        players.map((p) => p.page.getByTestId('own-item-notice').isVisible()),
      );
      expect(own.filter(Boolean)).toHaveLength(1);
      const author = own.indexOf(true);
      // Each item plays its author's own clip.
      sources.push((await host.page.getByTestId('showcase-video').getAttribute('src')) ?? '');
      await expect(host.page.locator('[data-testid=showcase] .tape')).toContainText(
        titles[author]!,
      );
      const score = SCORE_FOR_AUTHOR[author]!;
      const voters = players.filter((_, k) => k !== author);
      await Promise.all(
        voters.map(async (p) => {
          await p.page.getByTestId(`vote-pick-${score}`).click();
          await expect(p.page.getByTestId('vote-ack')).toContainText(String(score));
        }),
      );
      // The lock itself is checked below from the status log.
    }

    // ---- round results (TIMINGS=fast: auto-advances after 1 s) ----
    // The phase is too short to poll for: an init script records what each page showed.
    for (const p of players) {
      const seen = await roundResultsSeen(p, 3);
      // Results name each dub's clip (V14).
      expect(seen.clips.sort(), p.name).toEqual([...titles].sort());
    }

    // Every page saw each dub play and lock, in order.
    for (const p of players) {
      const log = await p.page.evaluate(
        () => (window as unknown as { __showcaseLog: string[] }).__showcaseLog,
      );
      const seen = log.filter((v) => /:(PLAYING|LOCKED)$/.test(v));
      expect(seen, `${p.name}: ${log.join(' | ')}`).toEqual(
        [1, 2, 3].flatMap((n) => [`Dub ${n} of 3:PLAYING`, `Dub ${n} of 3:LOCKED`]),
      );
    }

    expect(new Set(sources).size, sources.join(' | ')).toBe(3);

    // ---- final ----
    for (const p of players) {
      await expect(p.page.getByTestId('final')).toBeVisible();
      await expect(p.page.getByTestId('final-winner')).toHaveText('Alice');
      const rows = p.page.getByTestId('final-standings').locator('li');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toContainText('Alice');
      await expect(rows.nth(0)).toContainText('100');
      await expect(rows.nth(1)).toContainText('Bob');
      await expect(rows.nth(1)).toContainText('60');
      await expect(rows.nth(2)).toContainText('Cleo');
      await expect(rows.nth(2)).toContainText('20');
      await expect(p.page.getByTestId('replay')).toBeVisible();
      await expect(p.page.getByTestId('save-video')).toBeEnabled();
    }
    await expect(host.page.getByTestId('back-to-lobby')).toBeVisible();
  } finally {
    await closeAll(players);
  }
});
