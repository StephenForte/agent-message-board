import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { defineConfig, devices } from '@playwright/test';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) throw new Error('TEST_DATABASE_URL is required for e2e (CREATE DATABASE).');
const ownsDatabase = !process.env.AMB_E2E_DATABASE_URL;
const dbName = ownsDatabase ? `amb_e2e_${randomUUID().replaceAll('-', '')}`
  : new URL(process.env.AMB_E2E_DATABASE_URL!).pathname.slice(1);
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
if (ownsDatabase) await admin.query(`CREATE DATABASE "${dbName}"`);
await admin.end();
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${dbName}`;
process.env.AMB_E2E_DATABASE_URL = databaseUrl.toString();
if (ownsDatabase) {
  const pool = new pg.Pool({ connectionString: databaseUrl.toString() });
  try { await migrate(drizzle(pool), { migrationsFolder: 'drizzle' }); } finally { await pool.end(); }
}

const dropDatabase = () => {
  spawnSync(process.execPath, ['--input-type=module', '-e', `
    import pg from 'pg';
    const client = new pg.Client({ connectionString: process.env.ADMIN_URL });
    await client.connect();
    await client.query('DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)');
    await client.end();
  `], { env: { ...process.env, ADMIN_URL: adminUrl }, stdio: 'ignore' });
};
if (ownsDatabase) process.once('exit', dropDatabase);


// Exercise production Secure cookies and server-action origin checks over real local TLS.
const proxyScript = `
import https from 'node:https';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
const directory = execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim();
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', directory + '/key.pem',
    '-out', directory + '/cert.pem', '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const server = https.createServer({ key: readFileSync(directory + '/key.pem'), cert: readFileSync(directory + '/cert.pem') }, (req, res) => {
    const upstream = http.request({ hostname: '127.0.0.1', port: 3100, path: req.url, method: req.method,
      headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, (reply) => {
      res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
  }).listen(3101);
  const cleanup = () => { server.close(); rmSync(directory, { recursive: true, force: true }); process.exit(0); };
  process.on('SIGTERM', cleanup); process.on('SIGINT', cleanup); process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
} catch { rmSync(directory, { recursive: true, force: true }); process.exit(1); }
`;
const httpsProxyCommand = `node --input-type=module -e '${proxyScript.replaceAll("'", "'\\''")}'`;

export default defineConfig({
  testDir: './tests/e2e', fullyParallel: true, forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0, reporter: 'list',
  use: { baseURL: 'https://localhost:3101', ignoreHTTPSErrors: true, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [{
    command: 'npm start', url: 'http://127.0.0.1:3100/api/health', reuseExistingServer: false,
    env: {
      PORT: '3100', NODE_ENV: 'production',
      __NEXT_PRIVATE_ORIGIN: 'http://127.0.0.1:3100',
      DATABASE_URL: databaseUrl.toString(),
      BETTER_AUTH_SECRET: 'b'.repeat(48), CURSOR_HMAC_SECRET: 'c'.repeat(48),
      APP_BASE_URL: 'https://localhost:3101/', LOG_LEVEL: 'info',
      RESEND_API_KEY: 're_e2e_fixture', EMAIL_FROM: 'Board <board@example.test>',
    },
  }, { command: httpsProxyCommand, url: 'https://localhost:3101/api/health', ignoreHTTPSErrors: true, reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } }],
});
