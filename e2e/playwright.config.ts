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
    ...devices['Desktop Chrome'],
    baseURL: BASE,
    headless: true,
    permissions: ['microphone'],
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
      ],
    },
  },
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
