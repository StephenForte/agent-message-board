import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: true, forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm start', url: 'http://127.0.0.1:3100/api/health', reuseExistingServer: false,
    env: {
      PORT: '3100', NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://localhost:5432/amb_e2e_unused',
      BETTER_AUTH_SECRET: 'b'.repeat(48), CURSOR_HMAC_SECRET: 'c'.repeat(48),
      APP_BASE_URL: 'https://example.test', LOG_LEVEL: 'info',
    },
  },
});
