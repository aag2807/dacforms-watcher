import { defineConfig, devices } from '@playwright/test';

// BASE_URL lets you point the same suite at staging vs production.
const BASE_URL = process.env.BASE_URL || 'https://www.dacgroup.com';

export default defineConfig({
  testDir: './tests',
  // Live-site latency: give each form flow room, but fail fast on hangs.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Be a polite crawler against production: cap concurrency.
  workers: process.env.WORKERS ? Number(process.env.WORKERS) : 3,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    // In CI, also emit machine-readable output for the WordPress ingest pipeline.
    // The custom reporter builds the compact per-form summary that report-to-wp.mjs POSTs.
    ...(process.env.CI
      ? ([
          ['json', { outputFile: 'results.json' }],
          ['./src/reporters/summary-reporter.ts'],
        ] as const)
      : []),
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
    // Identify the automation in server logs; keep it honest.
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/149.0.0.0 Safari/537.36 DAC-QA-Playwright',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // Uncomment to widen browser coverage:
    // { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
    // { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
  ],
});
