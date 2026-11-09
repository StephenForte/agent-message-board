import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { defineConfig, devices } from '@playwright/test';
import pg from 'pg';

const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) throw new Error('TEST_DATABASE_URL is required for e2e (CREATE DATABASE).');
const dbName = `amb_e2e_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE "${dbName}"`);
await admin.end();
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${dbName}`;

const dropDatabase = () => {
  spawnSync(process.execPath, ['--input-type=module', '-e', `
    import pg from 'pg';
    const client = new pg.Client({ connectionString: process.env.ADMIN_URL });
    await client.connect();
    await client.query('DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)');
    await client.end();
  `], { env: { ...process.env, ADMIN_URL: adminUrl }, stdio: 'ignore' });
};
process.once('exit', dropDatabase);

export default defineConfig({
  testDir: './tests/e2e', fullyParallel: true, forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm start', url: 'http://127.0.0.1:3100/api/health', reuseExistingServer: false,
    env: {
      PORT: '3100', NODE_ENV: 'production',
      DATABASE_URL: databaseUrl.toString(),
      BETTER_AUTH_SECRET: 'b'.repeat(48), CURSOR_HMAC_SECRET: 'c'.repeat(48),
      APP_BASE_URL: 'https://example.test', LOG_LEVEL: 'info',
    },
  },
});
