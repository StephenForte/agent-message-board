import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test, type Page } from '@playwright/test';
import { hashPassword } from 'better-auth/crypto';
import { closeDb, createDatabase } from '../../../src/db/client';
import { account, user } from '../../../src/db/schema/auth';
import { organizations } from '../../../src/db/schema/org';
import { newId, type HumanPrincipal, withOrgBootstrapTx } from '../../../src/domain/kernel';
import { createProject } from '../../../src/domain/projects';

const password = 'synthetic-e2e-password';
const previousDatabaseUrl = process.env.DATABASE_URL;

test.beforeAll(() => {
  process.env.DATABASE_URL = process.env.AMB_E2E_DATABASE_URL;
});

test.afterAll(async () => {
  await closeDb();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

test.beforeEach(async ({ context }, info) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': `203.0.${info.workerIndex % 250}.${info.line % 250}` });
});

type Owner = { id: string; email: string; orgId: string };

function humanOf(owner: Owner): HumanPrincipal {
  return { kind: 'human', userId: owner.id, orgId: owner.orgId, siteAdmin: false, requestId: randomUUID(), interface: 'web' };
}

async function seedOwner(): Promise<Owner> {
  const runtime = createDatabase(process.env.AMB_E2E_DATABASE_URL!);
  const id = newId();
  const email = `${id}@example.com`;
  const orgId = newId();
  try {
    await runtime.db.insert(user).values({ id, email, name: 'E2E owner', emailVerified: true });
    await runtime.db.insert(account).values({ id: newId(), userId: id, accountId: id, providerId: 'credential', password: await hashPassword(password) });
    await withOrgBootstrapTx(orgId, async (tx) => {
      await tx.insert(organizations).values({ id: orgId, name: 'E2E org', ownerUserId: id, status: 'active' });
    }, runtime.db);
    return { id, email, orgId };
  } finally { await runtime.pool.end(); }
}

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/https:\/\/(localhost|127\.0\.0\.1):\d+\/$/);
}

async function makeProject(owner: Owner, name: string) {
  const slug = `p${randomBytes(6).toString('hex')}`;
  return createProject(humanOf(owner), { name, slug, idempotencyKey: randomUUID() });
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(5000).then(() => { child.kill('SIGKILL'); return exited; })]);
  await exited;
}

function probe(url: string): Promise<boolean> {
  const transport = url.startsWith('https:') ? https : http;
  return new Promise((resolve) => {
    const req = transport.get(url, { rejectUnauthorized: false }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
  });
}

async function waitForHttp(url: string, child: ChildProcess) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break;
    if (await probe(url)) return;
    await delay(100);
  }
  throw new Error(`Server did not become ready: ${url}`);
}

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { setOrgAnnouncement } from '../../../src/domain/announcements';
import { listTokens } from '../../../src/domain/credentials';
import { postRoot } from '../../../src/domain/messages';
test('wizard secret stays local; SDK sessions, briefing, and tenant isolation work', async ({ browser }, info) => {
  test.setTimeout(90_000);
  const httpPort = 3610 + info.workerIndex;
  const httpsPort = 3710 + info.workerIndex;
  const directory = mkdtempSync(join(tmpdir(), 'amb-t12-'));
  const urls: string[] = [];
  let output = '';
  let server: ChildProcess | undefined;
  let proxy: ChildProcess | undefined;
  let page: Page | undefined;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'),
      '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    writeFileSync(join(directory, 'proxy.mjs'), `
      import https from 'node:https';
      import http from 'node:http';
      import { readFileSync } from 'node:fs';
      const server = https.createServer({
        key: readFileSync(${JSON.stringify(join(directory, 'key.pem'))}),
        cert: readFileSync(${JSON.stringify(join(directory, 'cert.pem'))}),
      }, (req, res) => {
        const upstream = http.request({ hostname: '127.0.0.1', port: ${httpPort}, path: req.url, method: req.method,
          headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, (reply) => {
          res.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(res);
        });
        upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        req.pipe(upstream);
      });
      server.listen(${httpsPort}, '127.0.0.1');
    `);
    server = spawn(process.execPath, ['--import', 'tsx', 'src/lib/server.ts'], {
      env: {
        ...process.env, PORT: String(httpPort), NODE_ENV: 'production', HOSTNAME: '127.0.0.1',
        DATABASE_URL: process.env.AMB_E2E_DATABASE_URL, BETTER_AUTH_SECRET: 'b'.repeat(48), CURSOR_HMAC_SECRET: 'c'.repeat(48),
        APP_BASE_URL: `https://127.0.0.1:${httpsPort}/`, LOG_LEVEL: 'info', RESEND_API_KEY: 're_e2e_fixture',
        EMAIL_FROM: 'Board <board@example.test>', __NEXT_PRIVATE_ORIGIN: `http://127.0.0.1:${httpPort}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    server.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    await waitForHttp(`http://127.0.0.1:${httpPort}/api/health`, server);
    proxy = spawn(process.execPath, [join(directory, 'proxy.mjs')], { stdio: 'ignore' });
    await waitForHttp(`https://127.0.0.1:${httpsPort}/api/health`, proxy);

    const owner = await seedOwner();
    const alpha = await makeProject(owner, 'Wizard project');
    await setOrgAnnouncement(humanOf(owner), { title: 'Wizard announcement', body: 'Read this organization guidance.', expectedVersion: 0 });
    const root = await postRoot(humanOf(owner), { projectId: alpha.id, title: 'Pinned wizard handoff', body: 'Verified briefing context.', category: 'handoff', pinned: true, idempotencyKey: newId() });
    const context = await browser.newContext({ timezoneId: 'America/Los_Angeles', ignoreHTTPSErrors: true, baseURL: `https://127.0.0.1:${httpsPort}`, extraHTTPHeaders: { 'x-forwarded-for': '203.0.114.12' } });
    page = await context.newPage();
    page.on('request', (request) => urls.push(request.url()));
    await signIn(page, owner.email);
    await page.getByRole('link', { name: 'Connect', exact: true }).click();
    await page.getByRole('combobox', { name: 'Client', exact: true }).selectOption('Codex');
    await expect(page.getByRole('checkbox', { name: 'Can create projects' })).not.toBeChecked();
    await page.getByRole('radio', { name: /^Broad:/ }).check();
    await expect(page.getByRole('checkbox', { name: 'Can create projects' })).toBeChecked();
    await page.getByRole('radio', { name: /^Restricted:/ }).check();
    await expect(page.getByRole('checkbox', { name: 'Can create projects' })).not.toBeChecked();
    await page.getByLabel('Agent name', { exact: true }).fill('wizard-agent');
    await page.getByLabel('Token label', { exact: true }).fill('Wizard token');
    await page.getByRole('group', { name: 'Default projects', exact: true }).getByRole('checkbox', { name: alpha.name }).check();
    await page.getByRole('group', { name: 'Token project access' }).getByRole('checkbox', { name: alpha.name }).check();
    await page.getByLabel('Expiry (optional, local time)').fill('2030-06-01T09:30');
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route((url) => url.pathname === '/connect', async (route) => { if (route.request().method() === 'POST') await gate; await route.continue(); });
    const click = page.getByRole('button', { name: 'Create connection', exact: true }).click();
    try { await expect(page.getByRole('button', { name: 'Setting up…' })).toBeDisabled(); } finally { release(); }
    await click;
    const field = page.getByLabel('Token secret', { exact: true });
    await expect(field).toBeVisible();
    const secret = await field.inputValue();
    expect(/^amb_[0-9A-Za-z]{8}_[0-9A-Za-z]{40}$/.test(secret)).toBe(true);
    const token = (await listTokens(humanOf(owner))).find((t) => t.label === 'Wizard token');
    expect(token?.expiresAt).toBe('2030-06-01T16:30:00.000Z');
    // Opening reference documentation leaves this tab and its one-time setup intact.
    await context.route('https://learn.chatgpt.com/**', (route) => route.fulfill({ body: 'Official docs test fixture', contentType: 'text/html' }));
    const popupPromise = context.waitForEvent('page');
    await page.getByRole('link', { name: 'Official client documentation' }).click();
    const popup = await popupPromise;
    await popup.close();
    expect((await field.inputValue()) === secret).toBe(true);
    const diagnostics = await page.getByRole('link', { name: 'Open connection diagnostics' }).getAttribute('href');
    expect(diagnostics).toMatch(/^\/connect\/[a-f0-9-]+\/[a-f0-9-]+$/);
    // Snippets contain only env references, even while the secret is visible.
    expect((await page.locator('pre').allTextContents()).some((text) => text.includes(secret))).toBe(false);
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await page.goBack();
    await expect(page.getByLabel('Token secret', { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByLabel('Token secret', { exact: true })).toHaveCount(0);
    expect((await page.content()).includes(secret)).toBe(false);
    await page.goto(diagnostics!);
    await expect(page.getByText("Waiting for the agent's first connect_agent", { exact: true })).toBeVisible();
    const client = new Client({ name: 'T12 SDK', version: '1.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpPort}/api/mcp`), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
      const result = await client.callTool({ name: 'connect_agent', arguments: { name: 'wizard-agent', client_label: 'T12 SDK client' } });
      expect(result.isError).not.toBe(true);
      await page.getByRole('link', { name: 'Refresh diagnostics' }).click();
      await expect(page.getByRole('heading', { name: 'Recorded sessions' })).toBeVisible();
      await expect(page.getByText(/T12 SDK client/)).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Effective projects' }).locator('..')).toContainText('Wizard project · read/write');
      await expect(page.getByRole('heading', { name: 'Effective defaults' }).locator('..')).toContainText(alpha.name);
    } finally { await client.close(); }
    await page.goto(`/projects/${alpha.slug}`);
    await page.getByRole('link', { name: 'View agent briefing', exact: true }).click();
    const briefingUrl = page.url();
    await expect(page.getByRole('heading', { name: 'Wizard announcement' })).toBeVisible();
    const pinned = page.getByRole('region', { name: 'pinned', exact: true });
    await expect(pinned).toContainText(root.id);
    await expect(pinned).toContainText('Human: E2E owner');
    await expect(pinned).toContainText('handoff');
    await expect(pinned).toContainText('Pinned: yes');
    await expect(pinned).toContainText('Recipients: None');
    await expect(pinned.locator('time')).toHaveAttribute('dateTime', /T.*Z$/);
    await expect(page.getByText('The addressed group is per agent and is not shown in this human preview.')).toBeVisible();
    await page.getByText('Show Markdown output as plain text', { exact: true }).click();
    await expect(page.locator('details pre')).toContainText(root.id);
    await page.goto(`${briefingUrl}?continuation=invalid`);
    await expect(page.getByRole('alert').filter({ hasText: 'This briefing continuation' })).toContainText('Start a fresh briefing below to resync');
    await page.getByRole('link', { name: 'Start a fresh briefing' }).click();
    await expect(page).toHaveURL(briefingUrl);
    await expect(page.getByRole('heading', { name: 'Wizard announcement' })).toBeVisible();
    const stored = await page.evaluate(() => document.cookie + JSON.stringify(sessionStorage) + JSON.stringify(localStorage));
    expect(stored.includes(secret)).toBe(false);
    expect(urls.some((url) => url.includes(secret))).toBe(false);
    await expect.poll(() => output.includes('/connect'), { timeout: 15_000 }).toBe(true);
    expect(output.includes(secret)).toBe(false);
    const second = await seedOwner();
    const otherContext = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: `https://127.0.0.1:${httpsPort}`, extraHTTPHeaders: { 'x-forwarded-for': '203.0.114.13' } });
    try {
      const otherPage = await otherContext.newPage();
      await signIn(otherPage, second.email);
      expect((await otherPage.goto(diagnostics!))?.status()).toBe(404);
      expect((await otherPage.goto(briefingUrl))?.status()).toBe(404);
    } finally { await otherContext.close(); }
    await page.context().close();
    page = undefined;
  } finally {
    try { if (page) await page.context().close(); } finally {
      try { if (proxy) await stopProcess(proxy); } finally {
        if (server) await stopProcess(server);
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
});
