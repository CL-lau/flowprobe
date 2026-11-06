import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/acceptance',
  timeout: 60000,
  workers: 2,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    ...(process.env['FLOWPROBE_TEST_CHANNEL'] === 'chrome' ? { channel: 'chrome' } : {}),
  },
  webServer: {
    command: 'npm run simulator',
    url: 'http://127.0.0.1:4173/health',
    reuseExistingServer: !process.env['CI'],
    timeout: 30000,
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
