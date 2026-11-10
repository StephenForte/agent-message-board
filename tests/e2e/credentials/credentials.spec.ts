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
import { authenticateBearer, connectAgent, createToken, getAgentDefaults, listAgentSessions } from '../../../src/domain/credentials';
import { DomainError, newId, type HumanPrincipal, withOrgBootstrapTx } from '../../../src/domain/kernel';
import { createProject, listProjects } from '../../../src/domain/projects';

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

async function bearer(secret: string) {
  return authenticateBearer(`Bearer ${secret}`, { requestId: randomUUID(), interface: 'web' });
}

async function readSecret(page: Page) {
  const field = page.getByRole('textbox', { name: 'Token secret', exact: true });
  await expect(field).toBeVisible();
  const secret = await field.inputValue();
  expect(secret).toMatch(/^amb_[0-9A-Za-z]{8}_[0-9A-Za-z]{40}$/);
  return secret;
}

function tokenItem(page: Page, label: string) {
  return page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: label, exact: true }) });
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null) return;
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

test('create, replace, and revoke keep the secret out of the page, history, and server log', async ({ browser }, info) => {
  test.setTimeout(90_000);
  const httpPort = 3410 + info.workerIndex;
  const httpsPort = 3510 + info.workerIndex;
  const directory = mkdtempSync(join(tmpdir(), 'amb-t10-'));
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
    const alpha = await makeProject(owner, 'Alpha project');
    const beta = await makeProject(owner, 'Beta project');
    const context = await browser.newContext({
      ignoreHTTPSErrors: true, baseURL: `https://127.0.0.1:${httpsPort}`,
      extraHTTPHeaders: { 'x-forwarded-for': `203.0.113.${(info.workerIndex % 200) + 20}` },
    });
    page = await context.newPage();
    page.on('request', (request) => urls.push(request.url()));
    page.on('framenavigated', (frame) => { if (frame === page!.mainFrame()) urls.push(frame.url()); });
    await signIn(page, owner.email);
    await page.goto('/tokens');
    expect((await page.request.get('/tokens')).headers()['cache-control'] ?? '').toContain('no-store');
    await expect(page.getByText('No tokens yet.')).toBeVisible();

    const create = page.getByRole('region', { name: 'Create a token' });
    await expect(create.getByRole('checkbox', { name: 'Can create projects' })).toBeChecked();
    await create.getByRole('radio', { name: 'Restricted' }).check();
    await expect(create.getByText('only the listed projects')).toBeVisible();
    await expect(create.getByRole('checkbox', { name: 'Can create projects' })).not.toBeChecked();
    await create.getByLabel('Label', { exact: true }).fill('Restricted token');
    await create.getByRole('checkbox', { name: alpha.name }).check();
    await create.getByRole('button', { name: 'Create token', exact: true }).click();
    const restrictedSecret = await readSecret(page);
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Token secret', exact: true })).toHaveCount(0);
    expect((await page.content()).includes(restrictedSecret)).toBe(false);
    await page.getByRole('link', { name: 'Agents', exact: true }).click();
    await page.getByRole('link', { name: 'Tokens', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Token secret', exact: true })).toHaveCount(0);

    const restricted = tokenItem(page, 'Restricted token');
    await expect(restricted.getByText('Restricted', { exact: true })).toBeVisible();
    await expect(restricted.getByText('No', { exact: true })).toBeVisible();
    await expect(restricted.getByRole('definition').filter({ hasText: alpha.name })).toHaveCount(1);
    await expect(restricted.getByText('Not revoked', { exact: true })).toBeVisible();
    await expect(restricted).toContainText(`amb_${restrictedSecret.split('_')[1]}_…`);

    await create.getByRole('radio', { name: 'Broad' }).check();
    await expect(create.getByRole('checkbox', { name: 'Can create projects' })).toBeChecked();
    await create.getByLabel('Label', { exact: true }).fill('Broad token');
    await create.getByLabel('Expiry (optional)').fill('2030-06-01T09:30');
    await create.getByRole('button', { name: 'Create token', exact: true }).click();
    const broadSecret = await readSecret(page);
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Token secret', exact: true })).toHaveCount(0);
    const broad = tokenItem(page, 'Broad token');
    await expect(broad.getByText('Broad', { exact: true })).toBeVisible();
    await expect(broad.getByText('Yes', { exact: true })).toBeVisible();
    await expect(broad.getByText('UTC', { exact: false })).toBeVisible();
    await expect(broad.getByText('No expiry')).toHaveCount(0);

    const restrictedPrincipal = await bearer(restrictedSecret);
    const broadPrincipal = await bearer(broadSecret);
    expect((await listProjects(restrictedPrincipal)).map((project) => project.id)).toEqual([alpha.id]);
    expect((await listProjects(broadPrincipal)).map((project) => project.id).sort()).toEqual([alpha.id, beta.id].sort());

    await restricted.getByRole('button', { name: 'Replace', exact: true }).click();
    const replacement = await readSecret(page);
    await expect(page.getByText('Update your clients to use this secret, then revoke the old token.')).toBeVisible();
    expect((await bearer(restrictedSecret)).tokenId).toBe(restrictedPrincipal.tokenId);
    const replaced = await bearer(replacement);
    expect(replaced.tokenId).not.toBe(restrictedPrincipal.tokenId);
    const panel = page.getByRole('region', { name: 'New token secret' });
    await panel.getByRole('button', { name: 'Revoke the old token', exact: true }).click();
    await panel.getByRole('button', { name: 'Revoke Restricted token', exact: true }).click();
    await expect(tokenItem(page, 'Restricted token').getByText(/^Revoked /)).toBeVisible();
    await expect(bearer(restrictedSecret)).rejects.toBeInstanceOf(DomainError);
    await expect(bearer(restrictedSecret)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect((await bearer(replacement)).tokenId).toBe(replaced.tokenId);
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Token secret', exact: true })).toHaveCount(0);
    await expect(tokenItem(page, 'Restricted token').getByText(/^Revoked /)).toBeVisible();
    expect((await page.content()).includes(restrictedSecret)).toBe(false);
    expect((await page.content()).includes(broadSecret)).toBe(false);
    expect((await page.content()).includes(replacement)).toBe(false);

    const history = await (await page.context().newCDPSession(page)).send('Page.getNavigationHistory');
    const stored = await page.evaluate(() => document.cookie + JSON.stringify(sessionStorage) + JSON.stringify(localStorage) + location.href);
    const secrets = [restrictedSecret, broadSecret, replacement];
    for (const secret of secrets) {
      expect(urls.some((url) => url.includes(secret))).toBe(false);
      expect(JSON.stringify(history).includes(secret)).toBe(false);
      expect(stored.includes(secret)).toBe(false);
    }
    await expect.poll(() => output.includes('/tokens'), { timeout: 15_000 }).toBe(true);
    for (const secret of secrets) expect(output.includes(secret)).toBe(false);
    await page.context().close();
    page = undefined;
  } finally {
    if (page) await page.context().close();
    if (proxy) await stopProcess(proxy);
    if (server) await stopProcess(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a repeated click stays disabled while the create request is pending', async ({ page }) => {
  const owner = await seedOwner();
  await signIn(page, owner.email);
  await page.goto('/tokens');
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  await page.route((url) => url.pathname === '/tokens', async (route) => {
    if (!held && route.request().method() === 'POST') { held = true; await gate; }
    await route.continue();
  });
  await page.getByLabel('Label', { exact: true }).fill('Pending token');
  const submitted = page.getByRole('button', { name: 'Create token', exact: true }).click();
  try {
    await expect(page.getByRole('button', { name: 'Creating token…' })).toBeDisabled();
  } finally { release(); }
  await submitted;
  await expect(page.getByRole('textbox', { name: 'Token secret', exact: true })).toBeVisible();
});

test('whitespace labels are rejected without a driver error', async ({ page }) => {
  const owner = await seedOwner();
  await signIn(page, owner.email);
  await page.goto('/tokens');
  await page.getByLabel('Label', { exact: true }).fill('   ');
  await page.getByRole('button', { name: 'Create token', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Enter a label using 200 characters or fewer.');
  await expect(page.getByRole('textbox', { name: 'Token secret', exact: true })).toHaveCount(0);
});

test('editing grants removes a project from the token principal', async ({ page }) => {
  const owner = await seedOwner();
  const alpha = await makeProject(owner, 'Grant alpha');
  const beta = await makeProject(owner, 'Grant beta');
  await signIn(page, owner.email);
  await page.goto('/tokens');
  const create = page.getByRole('region', { name: 'Create a token' });
  await create.getByLabel('Label', { exact: true }).fill('Grant token');
  await create.getByRole('radio', { name: 'Restricted' }).check();
  await create.getByRole('checkbox', { name: alpha.name }).check();
  await create.getByRole('checkbox', { name: beta.name }).check();
  await create.getByRole('button', { name: 'Create token', exact: true }).click();
  const secret = await readSecret(page);
  await page.reload();
  const item = tokenItem(page, 'Grant token');
  await item.getByRole('checkbox', { name: alpha.name }).uncheck();
  await item.getByRole('button', { name: 'Save grants for Grant token', exact: true }).click();
  await expect(item.getByRole('status')).toContainText('applies on the agent\'s next request');
  const projects = await listProjects(await bearer(secret));
  expect(projects.map((project) => project.id)).toEqual([beta.id]);
});

test('agents list sessions and default projects without a running status', async ({ page }) => {
  const owner = await seedOwner();
  const project = await makeProject(owner, 'Default project');
  await signIn(page, owner.email);
  await page.goto('/agents');
  expect((await page.request.get('/agents')).headers()['cache-control'] ?? '').toContain('no-store');
  await expect(page.getByText('No agents yet.')).toBeVisible();
  await expect(page.getByText('not a running status')).toBeVisible();
  const issued = await createToken(humanOf(owner), { label: 'Session token', scope: 'org', canCreateProjects: false });
  const connected = await connectAgent(await bearer(issued.secret), { name: 'pilot-agent', clientLabel: 'Cursor' });
  await page.reload();
  const listed = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'pilot-agent', exact: true }) });
  await expect(listed).toBeVisible();
  await expect(listed).toContainText('Last seen');
  await expect(listed).not.toContainText('Running');
  await page.getByRole('link', { name: 'pilot-agent', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Cursor', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: `amb_${issued.token.prefix}_…`, exact: true })).toBeVisible();
  await expect(page.getByText('Defaults choose where the agent works by default but never grant access.')).toBeVisible();
  const sessions = await listAgentSessions(humanOf(owner), connected.agent.id);
  expect(sessions).toHaveLength(1);
  await page.getByRole('checkbox', { name: project.name }).check();
  await page.getByRole('button', { name: 'Save defaults', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Defaults saved.');
  const defaults = await getAgentDefaults(humanOf(owner), connected.agent.id);
  expect(defaults.map((item) => item.id)).toEqual([project.id]);
});

test('a token id or agent id from another organization is a 404', async ({ page }) => {
  const owner = await seedOwner();
  const other = await seedOwner();
  await makeProject(other, 'Foreign project');
  const issued = await createToken(humanOf(other), { label: 'Foreign token', scope: 'org', canCreateProjects: false });
  const connected = await connectAgent(await bearer(issued.secret), { name: 'foreign-agent', clientLabel: 'Other' });
  await signIn(page, owner.email);
  const agentResponse = await page.goto(`/agents/${connected.agent.id}`);
  const heading = await page.getByRole('heading', { level: 1 }).innerText();
  expect({ status: agentResponse?.status() ?? 0, heading }).toEqual({ status: 404, heading: 'Not found' });
  const tokenResponse = await page.goto(`/agents/${issued.token.id}`);
  expect(tokenResponse?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Not found', exact: true })).toBeVisible();
  expect((await page.content()).includes(issued.secret)).toBe(false);
});
