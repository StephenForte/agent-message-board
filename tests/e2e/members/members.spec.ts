import { expect, test, type Page } from '@playwright/test';
import { hashPassword } from 'better-auth/crypto';
import { createDatabase, closeDb } from '../../../src/db/client';
import { account, user } from '../../../src/db/schema/auth';
import { organizations } from '../../../src/db/schema/org';
import { newId, withOrgBootstrapTx } from '../../../src/domain/kernel';
import { createProject } from '../../../src/domain/projects';
import type { HumanPrincipal } from '../../../src/domain/kernel';

const password = 'synthetic-e2e-password';

test.beforeEach(async ({ context }, info) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': `198.51.${info.workerIndex % 250}.${info.line % 250}` });
});

test.afterAll(async () => { await closeDb(); });

async function seedOwner() {
  const runtime = createDatabase(process.env.AMB_E2E_DATABASE_URL!);
  const id = newId();
  const email = `${id}@example.com`;
  const orgId = newId();
  try {
    await runtime.db.insert(user).values({ id, email, name: 'Members owner', emailVerified: true });
    await runtime.db.insert(account).values({
      id: newId(), userId: id, accountId: id, providerId: 'credential', password: await hashPassword(password),
    });
    await withOrgBootstrapTx(orgId, async (tx) => {
      await tx.insert(organizations).values({ id: orgId, name: 'Members org', ownerUserId: id, status: 'active' });
    }, runtime.db);
    return { id, email, orgId };
  } finally { await runtime.pool.end(); }
}

async function seedVerifiedMember(email: string) {
  const runtime = createDatabase(process.env.AMB_E2E_DATABASE_URL!);
  const id = newId();
  try {
    await runtime.db.insert(user).values({ id, email, name: 'Invited member', emailVerified: true });
    await runtime.db.insert(account).values({
      id: newId(), userId: id, accountId: id, providerId: 'credential', password: await hashPassword(password),
    });
    return { id, email };
  } finally { await runtime.pool.end(); }
}

async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

function ownerPrincipal(owner: { id: string; orgId: string }): HumanPrincipal {
  return {
    kind: 'human', userId: owner.id, orgId: owner.orgId, role: 'owner',
    siteAdmin: false, interface: 'web', requestId: newId(),
  };
}

test('owner invites member who posts, manages own tokens, and is removed', async ({ page, browser }) => {
  test.setTimeout(120_000);
  process.env.DATABASE_URL = process.env.AMB_E2E_DATABASE_URL;
  const owner = await seedOwner();
  const project = await createProject(ownerPrincipal(owner), {
    name: 'Members board', slug: `m${newId().replaceAll('-', '').slice(0, 10)}`, idempotencyKey: newId(),
  });
  const memberEmail = `${newId()}@example.com`;
  // Signup+verify against the e2e Resend fixture is not deliverable; seed a verified
  // account for the invited email (same pattern as owner activation e2e), then join.
  await seedVerifiedMember(memberEmail);

  await signIn(page, owner.email);
  await expect(page).toHaveURL('https://localhost:3101/');
  await page.goto('/settings/members');
  await expect(page.getByRole('heading', { name: 'Organization members' })).toBeVisible();
  await page.screenshot({ path: 'tests/e2e/members/members-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: 'tests/e2e/members/members-375.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.getByLabel('Email', { exact: true }).fill(memberEmail);
  await page.getByRole('button', { name: 'Create invite link', exact: true }).click();
  await expect(page.getByText('Invitation link (shown once)')).toBeVisible();
  const linkText = await page.locator('.font-mono').first().innerText();
  expect(linkText).toMatch(/\/join\/[A-Za-z0-9_-]{43}/);
  const joinPath = new URL(linkText).pathname;
  await page.reload();
  await expect(page.getByText('Invitation link (shown once)')).toHaveCount(0);

  const memberContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'x-forwarded-for': '198.51.100.77' },
  });
  try {
    const memberPage = await memberContext.newPage();
    await memberPage.goto(`/sign-up?${new URLSearchParams({ returnTo: joinPath })}`);
    await expect(memberPage.getByRole('button', { name: 'Create account', exact: true })).toBeVisible();
    await signIn(memberPage, memberEmail);
    await expect(memberPage).toHaveURL(/\/no-organization$/);
    await memberPage.goto(joinPath);
    await expect(memberPage.getByText(memberEmail, { exact: false })).toBeVisible();
    await memberPage.getByRole('button', { name: 'Join organization', exact: true }).click();
    await expect(memberPage).toHaveURL('https://localhost:3101/');
    await expect(memberPage.getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
    await expect(memberPage.getByRole('link', { name: 'Agents', exact: true })).toHaveCount(0);
    await expect(memberPage.getByRole('link', { name: 'Tokens', exact: true })).toBeVisible();
    await expect(memberPage.getByRole('link', { name: 'Connect an agent', exact: true })).toBeVisible();

    await memberPage.goto(`/projects/${project.slug}`);
    await memberPage.locator('summary', { hasText: 'New post' }).click();
    await memberPage.getByLabel('Title', { exact: true }).fill('Member thread');
    await memberPage.getByLabel('Body').fill('Posted by the invited member');
    await memberPage.getByRole('button', { name: 'Post', exact: true }).click();
    await expect(memberPage.getByRole('heading', { name: 'Member thread' })).toBeVisible();

    await memberPage.goto('/tokens');
    const create = memberPage.getByRole('region', { name: 'Create a token' });
    await create.getByLabel('Label', { exact: true }).fill('member-token');
    await create.getByRole('checkbox', { name: 'Can create projects' }).uncheck();
    await create.getByRole('button', { name: 'Create token', exact: true }).click();
    await expect(memberPage.getByRole('textbox', { name: 'Token secret', exact: true })).toBeVisible({ timeout: 15_000 });
    await memberPage.reload();
    await expect(memberPage.locator('li').filter({ hasText: 'member-token' })).toHaveCount(1);

    for (const path of ['/settings', '/settings/audit', '/settings/members', '/agents', `/projects/${project.slug}/settings`]) {
      const response = await memberPage.request.get(path);
      expect(response.status(), path).toBe(404);
      await memberPage.goto(path);
      await expect(memberPage.getByRole('heading', { name: 'Not found' })).toBeVisible();
    }

    await page.goto('/settings/members');
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm remove', exact: true }).click();
    await expect(page.getByText(memberEmail)).toHaveCount(0);

    await memberPage.goto('/');
    await expect(memberPage.getByRole('heading', { name: 'No organization yet' })).toBeVisible();
  } finally {
    await memberContext.close();
  }
});
