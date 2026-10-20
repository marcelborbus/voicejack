import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/** Scratch space: fixture clips, client build, server uploads, test output. */
const TMP = process.env.E2E_TMP ?? path.join(os.tmpdir(), 'voicejack-e2e');
process.env.E2E_TMP = TMP;
const PORT = Number(process.env.E2E_PORT ?? 4791);
const BASE = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests',
  outputDir: path.join(TMP, 'test-results'),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: {
    baseURL: BASE,
    headless: true,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /record-firefox\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        permissions: ['microphone'],
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            '--disable-features=WebRtcHideLocalIpsWithMdns',
          ],
        },
      },
    },
    {
      // #49: the editor recording path on Firefox (it froze there). A HiDPI 1080p window makes
      // per-frame paint costs visible the way they hit real desktops.
      name: 'firefox',
      testMatch: /record-firefox\.spec\.ts/,
      // Runs after the Chromium suite: a 2x 1080p Firefox next to a Chromium worker starves
      // both (and the frame-rate check wants the machine to itself).
      dependencies: ['chromium'],
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 2,
        launchOptions: {
          firefoxUserPrefs: {
            'media.navigator.streams.fake': true,
            'media.navigator.permission.disabled': true,
            'media.autoplay.default': 0,
            'media.autoplay.block-webaudio': false,
          },
        },
      },
    },
    {
      // #48: voice effects in Firefox (OfflineAudioContext + AudioWorklet), after the frame-rate
      // check so the two Firefox runs never share the machine.
      name: 'firefox-fx',
      testMatch: /fx\.spec\.ts/,
      dependencies: ['firefox'],
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: {
            'media.navigator.streams.fake': true,
            'media.navigator.permission.disabled': true,
            'media.autoplay.default': 0,
            'media.autoplay.block-webaudio': false,
          },
        },
      },
    },
  ],
  webServer: {
    command: 'bash scripts/serve.sh',
    url: `${BASE}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { E2E_TMP: TMP, PORT: String(PORT) },
  },
});
