import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const env = { ...process.env, NODE_ENV: 'production',
  RESEND_API_KEY: 're_startup_fixture', EMAIL_FROM: 'Board <board@example.test>' };

for (const key of ['RESEND_API_KEY', 'EMAIL_FROM']) {
  const missingEmail = { ...env, DATABASE_URL: 'postgres://127.0.0.1:1/x',
    BETTER_AUTH_SECRET: 'a'.repeat(48), CURSOR_HMAC_SECRET: 'b'.repeat(48), APP_BASE_URL: 'https://example.test' };
  delete missingEmail[key];
  const rejected = spawnSync('npm', ['start'], { env: missingEmail, encoding: 'utf8', timeout: 20_000 });
  assert.equal(rejected.error, undefined);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stdout + rejected.stderr, new RegExp(`Invalid server configuration:.*${key}`));
  console.log(`PASS: production startup refuses missing ${key}`);
}
for (const key of ['DATABASE_URL', 'BETTER_AUTH_SECRET', 'CURSOR_HMAC_SECRET', 'APP_BASE_URL']) delete env[key];
const startup = spawnSync('npm', ['start'], { env, encoding: 'utf8', timeout: 20_000 });
assert.equal(startup.error, undefined);
assert.notEqual(startup.status, 0);
assert.match(startup.stdout + startup.stderr, /Invalid server configuration:.*DATABASE_URL/);
console.log('PASS: production startup refuses missing DATABASE_URL before listening');
const integrationEnv = { ...process.env };
delete integrationEnv.TEST_DATABASE_URL;
const integration = spawnSync('npm', ['run', 'test:integration'], { env: integrationEnv, encoding: 'utf8', timeout: 30_000 });
assert.equal(integration.error, undefined);
assert.notEqual(integration.status, 0);
assert.match(integration.stdout + integration.stderr, /TEST_DATABASE_URL is required/);
console.log('PASS: integration fails explicitly without TEST_DATABASE_URL');

const { spawn } = await import('node:child_process');
const { setTimeout: delay } = await import('node:timers/promises');
const { randomUUID } = await import('node:crypto');
const { Client } = await import('pg');

const unreachableUrl = 'postgresql://amb_invalid:amb_invalid@127.0.0.1:59999/amb_unreachable';
const refused = spawnSync(process.execPath, ['--import', 'tsx', 'src/lib/server.ts'], {
  env: { ...env, PORT: '3192', DATABASE_URL: unreachableUrl,
    BETTER_AUTH_SECRET: 'a'.repeat(48), CURSOR_HMAC_SECRET: 'b'.repeat(48),
    APP_BASE_URL: 'https://example.test', LOG_LEVEL: 'info' },
  encoding: 'utf8', timeout: 20_000,
});
assert.equal(refused.error, undefined);
assert.notEqual(refused.status, 0);
const refusedOutput = refused.stdout + refused.stderr;
assert.match(refusedOutput, /Database is unreachable/);
for (const hidden of ['amb_invalid', 'amb_unreachable', '59999']) assert.ok(!refusedOutput.includes(hidden), hidden);
console.log('PASS: production startup refuses an unreachable database without echoing the URL');

const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) {
  console.error('TEST_DATABASE_URL is required to prove startup against a real database');
  process.exit(1);
}
const proofName = `amb_proof_${randomUUID().replaceAll('-', '')}`;
const admin = new Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE "${proofName}"`);
await admin.end();
const proofUrl = new URL(adminUrl);
proofUrl.pathname = `/${proofName}`;

// Exercise the real production HTTP boundary, including the final 404 status.
const server = spawn(process.execPath, ['--import', 'tsx', 'src/lib/server.ts'], {
  env: { ...env, PORT: '3191', DATABASE_URL: proofUrl.toString(),
    BETTER_AUTH_SECRET: 'a'.repeat(48), CURSOR_HMAC_SECRET: 'b'.repeat(48),
    APP_BASE_URL: 'https://example.test', LOG_LEVEL: 'info' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
server.stdout.on('data', (chunk) => { output += chunk; });
server.stderr.on('data', (chunk) => { output += chunk; });
const exited = new Promise((resolve) => server.once('exit', resolve));
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error('Production server exited before readiness');
    try { const response = await fetch('http://127.0.0.1:3191/api/health'); ready = response.ok; } catch {}
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, 'production server becomes ready');
  const response = await fetch('http://127.0.0.1:3191/missing?token=never-log-query', {
    headers: { 'x-request-id': 'proof-404', authorization: 'never-log-header', cookie: 'never-log-cookie' },
  });
  await response.text();
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('x-request-id'), 'proof-404');
  const tokenPath = await fetch('http://127.0.0.1:3191/amb_public_private');
  await tokenPath.text();
  await delay(100);
  const logs = output.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  const completion = logs.find((entry) => entry.request_id === 'proof-404');
  assert.equal(completion.status, 404);
  assert.equal(completion.route, '/missing');
  assert.equal(typeof completion.latency_ms, 'number');
  for (const hidden of ['never-log-query', 'never-log-header', 'never-log-cookie', 'amb_public_private']) assert.ok(!output.includes(hidden));
  console.log('PASS: production request logs record real status/latency and redact credentials');
} finally {
  server.kill('SIGTERM');
  await Promise.race([exited, delay(5_000).then(() => { server.kill('SIGKILL'); })]);
  const drop = new Client({ connectionString: adminUrl });
  await drop.connect();
  await drop.query(`DROP DATABASE IF EXISTS "${proofName}" WITH (FORCE)`);
  await drop.end();
}
