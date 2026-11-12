import { mkdirSync } from 'node:fs';
import { hashPassword } from 'better-auth/crypto';
import { expect, test, type Page } from '@playwright/test';
import { createDatabase } from '../../../src/db/client';
import { user, account } from '../../../src/db/schema/auth';
import { organizations } from '../../../src/db/schema/org';
import { siteAdmins } from '../../../src/db/schema/site-admins';
import { newId, withOrgBootstrapTx } from '../../../src/domain/kernel';

const password = 'synthetic-e2e-password';

test.beforeEach(async ({ context }, info) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': `203.0.${info.workerIndex % 250}.${info.line % 250}` });
});

async function seed(options: { admin?: boolean; orgStatus?: 'active' | 'suspended' } = {}) {
  const runtime = createDatabase(process.env.AMB_E2E_DATABASE_URL!);
  const id = newId();
  const email = `${id}@example.com`;
  try {
    await runtime.db.insert(user).values({ id, email, name: 'E2E user', emailVerified: true });
    await runtime.db.insert(account).values({
      id: newId(), userId: id, accountId: id, providerId: 'credential', password: await hashPassword(password),
    });
    if (options.admin) await runtime.db.insert(siteAdmins).values({ userId: id });
    if (options.orgStatus) {
      const orgId = newId();
      await withOrgBootstrapTx(orgId, async (tx) => {
        await tx.insert(organizations).values({ id: orgId, name: 'E2E org', ownerUserId: id, status: options.orgStatus! });
      }, runtime.db);
    }
    return { id, email };
  } finally {
    await runtime.pool.end();
  }
}

async function seedOrganization(name: string, options: { slug?: string; ownerEmail?: string } = {}) {
  const runtime = createDatabase(process.env.AMB_E2E_DATABASE_URL!);
  const orgId = newId();
  const ownerId = newId();
  try {
    if (options.ownerEmail) {
      await runtime.db.insert(user).values({ id: ownerId, email: options.ownerEmail, name: 'Listed owner', emailVerified: true });
    }
    await withOrgBootstrapTx(orgId, async (tx) => {
      await tx.insert(organizations).values({
        id: orgId, name, status: 'active', slug: options.slug ?? null, ownerUserId: options.ownerEmail ? ownerId : null,
      });
    }, runtime.db);
    return orgId;
  } finally {
    await runtime.pool.end();
  }
}

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
}

async function createOrganization(page: Page, name: string, ownerEmail?: string) {
  await page.goto('/admin');
  await page.getByLabel('Name', { exact: true }).fill(name);
  if (ownerEmail) await page.getByLabel('Owner email', { exact: true }).fill(ownerEmail);
  await page.getByRole('button', { name: 'New organization', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/organizations\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname.split('/').at(-1)!;
}

test('the list shows a new organization and creating one opens its page', async ({ page }) => {
  test.setTimeout(90_000);
  const admin = await seed({ admin: true });
  const owner = await seed();
  await signIn(page, admin.email);
  const name = `Listed ${newId()}`;
  const id = await createOrganization(page, name, owner.email);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByText('Not set', { exact: true })).toBeVisible();
  const slug = `l${id.replaceAll('-', '').slice(0, 12)}`;
  await page.getByRole('textbox', { name: 'Public address', exact: true }).fill(slug);
  await page.getByRole('button', { name: 'Save public address', exact: true }).click();
  await expect(page.getByRole('link', { name: `https://localhost:3101/${slug}`, exact: true })).toBeVisible();

  await page.goto('/admin');
  const row = page.getByRole('listitem').filter({ has: page.getByRole('link', { name, exact: true }) });
  await expect(row.getByRole('link', { name, exact: true })).toHaveAttribute('href', `/admin/organizations/${id}`);
  await expect(row.getByText('Active', { exact: true })).toBeVisible();
  await expect(row.getByText(owner.email, { exact: true })).toBeVisible();
  await expect(row.getByRole('link', { name: `/${slug}`, exact: true })).toHaveAttribute('href', `/${slug}`);
  const time = row.locator('time');
  await expect(time).toHaveText(/just now|^\d+ [mhd] ago$/);
  await expect(time).toHaveAttribute('datetime', /^\d{4}-/);
  await expect(time).toHaveAttribute('title', /20\d{2}/);
});

test('suspend asks for confirmation, cancel keeps the organization active, and restore clears the suspension', async ({ page }) => {
  test.setTimeout(90_000);
  const admin = await seed({ admin: true });
  await signIn(page, admin.email);
  await createOrganization(page, `Suspend ${newId()}`);
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Suspend organization', exact: true }).click();
  await expect(page.getByText(/owner sees the suspended page/i)).toBeVisible();
  await expect(page.getByText('org_suspended', { exact: false })).toBeVisible();
  await expect(page.getByText(/public pages return 404/i)).toBeVisible();
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore organization', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText('org_suspended')).toHaveCount(0);
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Suspend organization', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm suspend', exact: true }).click();
  await expect(page.getByText('Suspended', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore organization', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Restore organization', exact: true }).click();
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Suspend organization', exact: true })).toBeVisible();
});

test('a duplicate public address shows already in use next to the input', async ({ page }) => {
  test.setTimeout(90_000);
  const admin = await seed({ admin: true });
  await signIn(page, admin.email);
  const first = await createOrganization(page, `Address A ${newId()}`);
  const slug = `d${first.replaceAll('-', '').slice(0, 12)}`;
  await page.getByRole('textbox', { name: 'Public address', exact: true }).fill(slug);
  await page.getByRole('button', { name: 'Save public address', exact: true }).click();
  await expect(page.getByRole('link', { name: `https://localhost:3101/${slug}`, exact: true })).toBeVisible();
  await createOrganization(page, `Address B ${newId()}`);
  const input = page.getByRole('textbox', { name: 'Public address', exact: true });
  await input.fill(slug);
  await page.getByRole('button', { name: 'Save public address', exact: true }).click();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveAttribute('aria-describedby', /public-address-error/);
  await expect(input.locator('xpath=following-sibling::*[1]')).toContainText(/already in use/i);
});

test('unknown organization pages 404 for an admin, and a real page 404s for everyone else', async ({ page }) => {
  test.setTimeout(60_000);
  const admin = await seed({ admin: true });
  const owner = await seed({ orgStatus: 'active' });
  const orgId = await seedOrganization(`Hidden ${newId()}`);
  await signIn(page, admin.email);
  expect((await page.goto(`/admin/organizations/${newId()}`))?.status()).toBe(404);
  expect((await page.goto('/admin/organizations/not-a-uuid'))?.status()).toBe(404);
  expect((await page.goto(`/admin/organizations/${orgId}`))?.status()).toBe(200);

  await page.context().clearCookies();
  expect((await page.goto(`/admin/organizations/${orgId}`))?.status()).toBe(404);

  await signIn(page, owner.email);
  expect((await page.goto(`/admin/organizations/${orgId}`))?.status()).toBe(404);
});

test('the list and an organization page do not scroll sideways at 375px', async ({ page }) => {
  test.setTimeout(60_000);
  const admin = await seed({ admin: true });
  const ownerEmail = `${'n'.repeat(40)}.${newId()}@example.com`;
  const name = `Narrow ${'organization '.repeat(6)}${newId()}`;
  const slug = `n${newId().replaceAll('-', '')}`.slice(0, 40);
  const orgId = await seedOrganization(name, { slug, ownerEmail });
  await signIn(page, admin.email);
  mkdirSync('tests/e2e/admin/screenshots', { recursive: true });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/admin');
  await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
  await page.screenshot({ path: 'tests/e2e/admin/screenshots/list-desktop.png', fullPage: true });
  await page.goto(`/admin/organizations/${orgId}`);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.screenshot({ path: 'tests/e2e/admin/screenshots/organization-desktop.png', fullPage: true });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/admin');
  await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'tests/e2e/admin/screenshots/list-375.png', fullPage: true });
  await page.goto(`/admin/organizations/${orgId}`);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'tests/e2e/admin/screenshots/organization-375.png', fullPage: true });
});
