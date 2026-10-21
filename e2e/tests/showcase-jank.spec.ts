import { expect, test } from '@playwright/test';
import { closeAll, newPlayer } from './helpers';

// #53: showcase playback stays in sync under main-thread jank. While each dub plays, a 300–500 ms
// long task runs every second. The video must follow the server timeline (same machine, so the
// wall clock since `startAt`) within 150 ms once converged, without a single corrective seek.
// Runs in Chromium (`chromium` project) and Firefox (`firefox-jank`).

interface Sample {
  item: string;
  /** ms since the item's startAt */
  t: number;
  drift: number;
}

/** Records drift samples, seeks and frame stats during PLAYING; installed before load. */
function installSyncProbe() {
  const w = window as unknown as {
    __sync: {
      samples: Sample[];
      seeks: number;
      dropped: number;
      frames: number;
      jank: number;
      jankEnd: number;
      startAt: number | null;
      item: string | null;
    };
  };
  w.__sync = {
    samples: [],
    seeks: 0,
    dropped: 0,
    frames: 0,
    jank: 0,
    jankEnd: 0,
    startAt: null,
    item: null,
  };
  const s = w.__sync;
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string' || !ev.data.includes('"showcase"')) return;
        try {
          const m = JSON.parse(ev.data) as {
            state?: {
              showcase?: { submissionId: string; status: string; startAt: number | null } | null;
            };
          };
          const sc = m.state?.showcase;
          if (sc?.status === 'PLAYING' && sc.startAt !== null) {
            s.startAt = sc.startAt;
            s.item = sc.submissionId;
          } else if (sc) s.startAt = null;
        } catch {
          /* not JSON */
        }
      });
    }
  };
  let seekHooked: HTMLVideoElement | null = null;
  let quality: { d: number; f: number } | null = null;
  setInterval(() => {
    const v = document.querySelector<HTMLVideoElement>('[data-testid=showcase-video]');
    if (!v) return;
    if (seekHooked !== v) {
      seekHooked = v;
      v.addEventListener('seeking', () => {
        // A seek while an item plays (and is not a late join: we are on time) is a correction.
        if (s.startAt !== null && Date.now() - s.startAt > 500) s.seeks++;
      });
    }
    if (s.startAt === null || !s.item || v.paused) {
      quality = null;
      return;
    }
    const t = Date.now() - s.startAt;
    if (t < 0 || t > v.duration * 1000 - 300) return;
    // Right after a long task Firefox still reports the pre-stall `currentTime` (its media clock
    // reaches the main thread asynchronously; frames keep being shown): not a real drift.
    if (performance.now() - s.jankEnd < 300) return;
    s.samples.push({ item: s.item, t, drift: v.currentTime * 1000 - t });
    const q = v.getVideoPlaybackQuality?.();
    if (q) {
      if (quality) {
        s.dropped += q.droppedVideoFrames - quality.d;
        s.frames += q.totalVideoFrames - quality.f;
      }
      quality = { d: q.droppedVideoFrames, f: q.totalVideoFrames };
    }
  }, 100);
  // The jank: a 300–500 ms long task every second while an item plays.
  setInterval(() => {
    if (s.startAt === null) return;
    s.jank++;
    const end = performance.now() + 300 + Math.random() * 200;
    while (performance.now() < end) {
      /* busy */
    }
    s.jankEnd = performance.now();
  }, 1000);
}

test('showcase stays in sync under 300–500 ms long tasks', async ({ browser }) => {
  test.setTimeout(120_000);
  const admin = await newPlayer(browser, 'Admin');
  try {
    const { page } = admin;
    await admin.context.addInitScript(installSyncProbe);
    await page.goto('/admin');
    const card = page.getByTestId('test-game-card');
    await card.getByTestId('test-game-bots').fill('2');
    await card.getByTestId('test-game-rounds').fill('1');
    await card.getByTestId('test-game-seconds').fill('5');
    await card.getByTestId('test-game-start').click();
    await expect(page.getByTestId('editor')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('done').click();
    await expect(page.locator('[data-testid=showcase] h2')).toContainText('of 2', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('round-results').or(page.getByTestId('final'))).toBeVisible({
      timeout: 90_000,
    });
    const r = await page.evaluate(() => {
      const w = window as unknown as {
        __sync: {
          samples: { item: string; t: number; drift: number }[];
          seeks: number;
          dropped: number;
          frames: number;
          jank: number;
        };
        __vjShowcase?: { hardSeeks: number };
      };
      return { ...w.__sync, hardSeeks: w.__vjShowcase?.hardSeeks ?? null };
    });
    // Converged = from 2 s into each item on.
    const settled = r.samples.filter((x) => x.t >= 2000).map((x) => Math.abs(x.drift));
    settled.sort((a, b) => a - b);
    const items = new Set(r.samples.map((x) => x.item)).size;
    const stats = {
      items,
      jank: r.jank,
      samples: settled.length,
      p50: Math.round(settled[Math.floor(settled.length / 2)] ?? NaN),
      p95: Math.round(settled[Math.floor(settled.length * 0.95)] ?? NaN),
      max: Math.round(settled.at(-1) ?? NaN),
      seeks: r.seeks,
      hardSeeks: r.hardSeeks,
      droppedPct: r.frames ? Math.round((1000 * r.dropped) / r.frames) / 10 : null,
    };
    console.log(`[showcase-jank ${test.info().project.name}] ${JSON.stringify(stats)}`);
    if (process.env.JANK_DUMP)
      console.log(
        JSON.stringify(r.samples.map((x) => [x.item.slice(0, 4), x.t, Math.round(x.drift)])),
      );
    test.info().annotations.push({ type: 'sync', description: JSON.stringify(stats) });
    expect(items).toBe(2);
    expect(r.jank).toBeGreaterThan(5);
    expect(settled.length).toBeGreaterThan(20);
    expect(stats.max, 'drift after convergence').toBeLessThan(150);
    expect(r.seeks, 'corrective seeks').toBe(0);
    expect(r.hardSeeks).toBe(0);
  } finally {
    await closeAll([admin]);
  }
});
