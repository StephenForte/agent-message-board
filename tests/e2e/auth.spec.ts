import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test, type Page } from '@playwright/test';
import { hashPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../../src/db/client';
import { user, account, session } from '../../src/db/schema/auth';
import { siteAdmins } from '../../src/db/schema/site-admins';
import { organizations } from '../../src/db/schema/org';
import { newId, withOrgBootstrapTx } from '../../src/domain/kernel';

const password = 'synthetic-e2e-password';
// Independent clients must not consume one another's default per-IP login budget.
test.beforeEach(async ({ context }, info) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': `192.0.${info.workerIndex % 250}.${info.line % 250}` });
});
async function seed(options: { admin?: boolean; orgStatus?: 'active' | 'suspended' } = {}) {
  const runtime = createDatabase(process.env.AMB_E2E_DATABASE_URL!);
  const id = newId(); const email = `${id}@example.com`;
  try {
    await runtime.db.insert(user).values({ id, email, name: 'E2E user', emailVerified: true });
    await runtime.db.insert(account).values({ id: newId(), userId: id, accountId: id, providerId: 'credential', password: await hashPassword(password) });
    if (options.admin) await runtime.db.insert(siteAdmins).values({ userId: id });
    if (options.orgStatus) {
      const orgId = newId();
      await withOrgBootstrapTx(orgId, async (tx) => {
        await tx.insert(organizations).values({ id: orgId, name: 'E2E org', ownerUserId: id, status: options.orgStatus! });
      }, runtime.db);
    }
    return { id, email };
  } finally { await runtime.pool.end(); }
}
async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('verified owner signs in with secure cookies and reaches the home page', async ({ page, context }) => {
  const owner = await seed({ orgStatus: 'active' });
  await signIn(page, owner.email);
  await expect(page).toHaveURL('https://localhost:3101/');
  await expect(page.getByRole('heading', { name: 'Agent Message Board' })).toBeVisible();
  const cookie = (await context.cookies()).find((c) => c.name.includes('session_token'))!;
  expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Lax' });
});

test('admin creates an organization, associates an owner, suspends and restores it', async ({ page }) => {
  const admin = await seed({ admin: true }); const owner = await seed();
  await signIn(page, admin.email);
  await expect(page).toHaveURL(/\/no-organization$/);
  await page.goto('/admin');
  const name = `Created by admin ${newId()}`;
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'New organization', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/organizations\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Suspend organization', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm suspend', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restore organization', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Restore organization', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Suspend organization', exact: true })).toBeVisible();
  const association = page.locator('form').filter({ has: page.getByRole('button', { name: 'Set owner', exact: true }) });
  await association.getByLabel('Owner email', { exact: true }).fill(owner.email);
  await association.getByRole('button', { name: 'Set owner', exact: true }).click();
  await expect(page.getByRole('main')).toContainText(owner.email);
});

test('admin activation link is displayed once and invited user can claim it', async ({ page, browser }) => {
  const admin = await seed({ admin: true }); const owner = await seed();
  await signIn(page, admin.email); await expect(page).toHaveURL(/\/no-organization$/);
  await page.goto('/admin'); const name = `Activation org ${newId()}`;
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'New organization', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/organizations\/[0-9a-f-]{36}$/);
  const invite = page.locator('form').filter({ has: page.getByRole('button', { name: 'Create invite link', exact: true }) });
  await invite.getByLabel('Invite email', { exact: true }).fill(owner.email);
  await invite.getByRole('button', { name: 'Create invite link', exact: true }).click();
  const displayed = page.getByLabel('Activation link', { exact: true });
  await expect(displayed).toBeVisible(); const link = await displayed.inputValue();
  await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByLabel('Activation link', { exact: true })).toHaveCount(0);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: { 'x-forwarded-for': '198.51.100.88' } });
  try {
    const invited = await context.newPage();
    await invited.goto(link); await expect(invited.getByText(owner.email, { exact: false })).toBeVisible();
    await invited.getByRole('link', { name: 'Sign in', exact: true }).click();
    await invited.getByLabel('Email', { exact: true }).fill(owner.email);
    await invited.getByLabel('Password', { exact: true }).fill(password);
    await invited.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(invited.getByRole('button', { name: 'Activate organization', exact: true })).toBeVisible();
    await invited.getByRole('button', { name: 'Activate organization', exact: true }).click();
    await expect(invited).toHaveURL('https://localhost:3101/');
  } finally { await context.close(); }
});

test('non-admin and anonymous users receive 404 for admin', async ({ page }) => {
  const anonymous = await page.goto('/admin'); expect(anonymous?.status()).toBe(404);
  const owner = await seed({ orgStatus: 'active' }); await signIn(page, owner.email);
  await expect(page).toHaveURL('https://localhost:3101/');
  expect((await page.goto('/admin'))?.status()).toBe(404);
});

test('suspended owner lands on suspension page, can sign out, and expired session shows a message', async ({ page }) => {
  const owner = await seed({ orgStatus: 'suspended' }); await signIn(page, owner.email);
  await expect(page.getByRole('heading', { name: 'This organization is suspended' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await signIn(page, owner.email); await expect(page).toHaveURL(/\/suspended$/);
  const runtime = createDatabase(process.env.AMB_E2E_DATABASE_URL!);
  try { await runtime.db.update(session).set({ expiresAt: new Date(0) }).where(eq(session.userId, owner.id)); }
  finally { await runtime.pool.end(); }
  await page.goto('/suspended');
  await expect(page).toHaveURL(/\/sign-in\?message=session-expired$/);
  await expect(page.getByRole('status')).toContainText('session has expired');
});

test('real production stdout redacts activation and password-reset credentials', async () => {
  test.setTimeout(30000);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/lib/server.ts'], {
    env: { ...process.env, PORT: '3193', NODE_ENV: 'production', DATABASE_URL: process.env.AMB_E2E_DATABASE_URL,
      BETTER_AUTH_SECRET: 'a'.repeat(48), CURSOR_HMAC_SECRET: 'b'.repeat(48), APP_BASE_URL: 'https://example.test',
      RESEND_API_KEY: 're_logging_fixture', EMAIL_FROM: 'board@example.test', LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) break;
      try { ready = (await fetch('http://127.0.0.1:3193/api/health')).ok; } catch {}
      if (ready) break; await delay(100);
    }
    expect(ready).toBe(true);
    const activation = randomBytes(32).toString('base64url');
    const reset = randomBytes(24).toString('base64url');
    for (const path of [`/activate/${activation}`, `//activate/${activation}`, `/api/auth/reset-password/${reset}?callbackURL=/reset-password`]) {
      const response = await fetch(`http://127.0.0.1:3193${path}`, { redirect: 'manual' }); await response.text();
    }
    await expect.poll(() => output.includes('/api/auth/reset-password/[redacted]')).toBe(true);
    expect(output.includes(activation)).toBe(false); expect(output.includes(reset)).toBe(false);
    expect(output).toContain('/activate/[redacted]');
  } finally {
    child.kill('SIGTERM');
    await Promise.race([exited, delay(5000).then(() => { child.kill('SIGKILL'); })]);
    await exited;
  }
});

test('default auth limiter also protects server-action sign-in attempts', async ({ page }) => {
  const owner = await seed();
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.goto('/sign-in');
    await page.getByLabel('Email', { exact: true }).fill(owner.email);
    await page.getByLabel('Password', { exact: true }).fill('incorrect-synthetic-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('status')).toContainText(attempt === 3 ? 'Too many attempts' : 'Unable to sign in');
  }
});

test('invited signup and verification pages preserve return path and new-password hints', async ({ page }) => {
  const next = `/activate/${'x'.repeat(43)}`;
  const query = new URLSearchParams({ returnTo: next });
  await page.goto(`/sign-up?${query}`);
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute('href', `/sign-in?${query}`);
  await expect(page.getByLabel('Password (at least 8 characters)', { exact: true })).toHaveAttribute('autocomplete', 'new-password');
  await page.goto(`/verify-email?${query}`);
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute('href', `/sign-in?${query}`);
  await page.goto('/reset-password?token=synthetic-reset-probe');
  await expect(page.getByLabel('New password', { exact: true })).toHaveAttribute('autocomplete', 'new-password');
  await page.goto('/sign-in');
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('autocomplete', 'current-password');
});
