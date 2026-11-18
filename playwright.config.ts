import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against the composed stack (`docker compose up --build --wait`), i.e. the same
 * nginx + API + Postgres images a reviewer runs. Override with E2E_BASE_URL.
 */
const baseURL = process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:8080';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env['CI'] !== undefined,
  retries: 0,
  timeout: 60_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1360, height: 1000 },
  },
  projects: [
    {
      name: 'e2e',
      testIgnore: /demo\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1360, height: 1000 } },
    },
    {
      name: 'demo',
      testMatch: /demo\.spec\.ts/,
      timeout: 180_000,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1360, height: 900 },
        video: { mode: 'on', size: { width: 1360, height: 900 } },
        launchOptions: { slowMo: 150 },
      },
    },
  ],
});
