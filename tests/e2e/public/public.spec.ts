import { mkdirSync } from 'node:fs';
import { hashPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { expect, test, type Page } from '@playwright/test';
import { user, account } from '../../../src/db/schema/auth';
import { agentTokens } from '../../../src/db/schema/identity';
import { organizations } from '../../../src/db/schema/org';
import { siteAdmins } from '../../../src/db/schema/site-admins';
import { newId, type HumanPrincipal } from '../../../src/domain/kernel';
import { postReply } from '../../../src/domain/messages';
import { setOrganizationSlug } from '../../../src/domain/organizations';
import { setProjectVisibility, updateProject } from '../../../src/domain/projects';
import { archiveThread, closeDb, postAs, seedAgent, seedOwner, seedProject, signIn, password } from '../board/helpers';
import { withE2e } from '../shell/helpers';

test.beforeEach(async ({ context }, info) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': `198.18.${info.workerIndex % 250}.${info.line % 250}` });
});
test.afterAll(async () => { await closeDb(); });

async function seedSiteAdmin() {
  return withE2e(async (db) => {
    const id = newId();
    const email = `${id}@example.com`;
    await db.insert(user).values({ id, email, name: 'E2E admin', emailVerified: true });
    await db.insert(account).values({
      id: newId(), userId: id, accountId: id, providerId: 'credential', password: await hashPassword(password),
    });
    await db.insert(siteAdmins).values({ userId: id });
    const principal: HumanPrincipal = { kind: 'human', userId: id, orgId: null, siteAdmin: true, interface: 'web', requestId: newId() };
    return { id, email, principal };
  });
}

async function signInLoose(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
}

async function expectNoindex(page: Page) {
  const robots = page.locator('meta[name="robots"]');
  await expect(robots).not.toHaveCount(0);
  const contents = await robots.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('content') ?? ''));
  expect(contents.length).toBeGreaterThan(0);
  for (const content of contents) expect(content).toMatch(/noindex/);
}

async function prefixOf(tokenId: string) {
  return withE2e(async (db) => {
    const [row] = await db.select({ prefix: agentTokens.prefix }).from(agentTokens).where(eq(agentTokens.id, tokenId));
    if (!row) throw new Error('missing token');
    return row.prefix;
  });
}

async function renameOrg(orgId: string, name: string) {
  await withE2e(async (db) => {
    await db.update(organizations).set({ name }).where(eq(organizations.id, orgId));
  });
}

test('owner publishes a project and a signed-out visitor reads its threads', async ({ page, browser }) => {
  test.setTimeout(90_000);
  const owner = await seedOwner();
  const admin = await seedSiteAdmin();
  const orgName = `Public ${owner.orgId.slice(0, 8)}`;
  const orgSlug = `p${owner.orgId.replaceAll('-', '').slice(0, 12)}`;
  await renameOrg(owner.orgId, orgName);
  const project = await seedProject(owner, 'Public board');
  await updateProject(owner.principal(), project.id, { description: 'Shown to visitors' });
  const recipient = await seedAgent(owner, 'recipient-only');
  const author = await seedAgent(owner, 'field-agent');
  const prefix = await prefixOf(author.principal.tokenId);
  const root = await postAs(owner.principal(), project.id, {
    title: 'Public thread title', body: 'Public body visible to visitors', recipients: [recipient.agentId],
  });
  await postReply(author.principal, { rootId: root.id, body: 'Reply visible to visitors', recipients: [], idempotencyKey: newId() });
  const archived = await postAs(owner.principal(), project.id, { title: 'Archived secret thread', body: 'archived only' });
  await archiveThread(owner, archived.id);

  await signInLoose(page, admin.email);
  await page.goto('/admin');
  const card = page.locator('li', { has: page.getByRole('heading', { name: orgName, exact: true }) });
  await card.getByLabel('Public address').fill(orgSlug);
  await card.getByRole('button', { name: 'Save public address' }).click();
  await expect(card.getByText(`Public address /${orgSlug}`)).toBeVisible();

  await page.context().clearCookies();
  await signIn(page, owner.email);
  await page.goto(`/projects/${project.slug}/settings`);
  await page.getByRole('button', { name: 'Make this project public' }).click();
  await expect(page.getByText('Anyone will be able to read the active threads in this project, without signing in.')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm: make active threads public' }).click();
  await expect(page.getByText('This project is public.')).toBeVisible();

  const visitor = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: 'https://localhost:3101' });
  const publicPage = await visitor.newPage();
  const list = await publicPage.goto(`/${orgSlug}/${project.slug}`);
  expect(list?.status()).toBe(200);
  expect(list?.headers()['x-robots-tag']).toContain('noindex');
  await expectNoindex(publicPage);
  await expect(publicPage.getByRole('heading', { name: 'Public board' })).toBeVisible();
  await expect(publicPage.getByText('Shown to visitors')).toBeVisible();
  await expect(publicPage.getByRole('link', { name: 'Public thread title' })).toBeVisible();
  await expect(publicPage.getByText('Archived secret thread')).toHaveCount(0);
  await expect(publicPage.getByRole('link', { name: 'Archived', exact: true })).toHaveCount(0);
  await expect(publicPage.getByRole('button', { name: 'Post', exact: true })).toHaveCount(0);
  mkdirSync('test-results', { recursive: true });
  await publicPage.screenshot({ path: 'test-results/public-list.png', fullPage: true });
  await publicPage.getByRole('link', { name: 'Public thread title' }).click();
  await expect(publicPage.getByText('Public body visible to visitors')).toBeVisible();
  await expect(publicPage.getByText('Reply visible to visitors')).toBeVisible();
  await expect(publicPage.getByRole('button', { name: 'Reply', exact: true })).toHaveCount(0);
  await expect(publicPage.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
  const threadResponse = await publicPage.goto(`/${orgSlug}/${project.slug}/threads/${root.id}`);
  expect(threadResponse?.headers()['x-robots-tag']).toContain('noindex');
  await publicPage.screenshot({ path: 'test-results/public-thread.png', fullPage: true });
  const html = await publicPage.content();
  expect(html).not.toContain('recipient-only');
  expect(html).not.toContain(owner.id);
  expect(html).not.toContain(prefix);
  expect(html).not.toContain(author.principal.tokenId);
  expect(html).not.toContain(author.principal.sessionId ?? 'missing-session');
  expect(html).not.toContain(recipient.agentId);

  await page.getByRole('button', { name: 'Make this project private' }).click();
  await expect(page.getByText('This project is private.')).toBeVisible();
  const hidden = await publicPage.goto(`/${orgSlug}/${project.slug}`);
  expect(hidden?.status()).toBe(404);
  const hiddenThread = await publicPage.goto(`/${orgSlug}/${project.slug}/threads/${root.id}`);
  expect(hiddenThread?.status()).toBe(404);
  await visitor.close();
});

test('private project, archived thread, and unknown slug share one not-found response', async ({ browser }) => {
  test.setTimeout(60_000);
  const owner = await seedOwner();
  const admin = await seedSiteAdmin();
  const orgSlug = `q${owner.orgId.replaceAll('-', '').slice(0, 12)}`;
  await setOrganizationSlug(admin.principal, owner.orgId, orgSlug);
  const project = await seedProject(owner, 'Shared board');
  const hidden = await seedProject(owner, 'Hidden board');
  await setProjectVisibility(owner.principal(), project.id, 'public');
  const live = await postAs(owner.principal(), project.id, { title: 'Still public', body: 'still public body' });
  const archived = await postAs(owner.principal(), project.id, { title: 'Gone thread', body: 'gone body' });
  await archiveThread(owner, archived.id);
  const visitor = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: 'https://localhost:3101' });
  const page = await visitor.newPage();
  const liveResponse = await page.goto(`/${orgSlug}/${project.slug}/threads/${live.id}`);
  expect(liveResponse?.status()).toBe(200);
  async function notFoundText(path: string) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
    expect(response?.headers()['x-robots-tag'], path).toContain('noindex');
    await expectNoindex(page);
    return page.locator('main').innerText();
  }
  const unknown = await notFoundText('/missing-org-slug/missing-project');
  const privateBody = await notFoundText(`/${orgSlug}/${hidden.slug}`);
  const archivedBody = await notFoundText(`/${orgSlug}/${project.slug}/threads/${archived.id}`);
  expect(privateBody).toBe(unknown);
  expect(archivedBody).toBe(unknown);
  expect(unknown).toContain('Not found');
  expect(unknown).not.toContain('Hidden board');
  expect(unknown).not.toContain('Gone thread');
  await visitor.close();
});

test('signed-out visitor reads only active threads on a public project', async ({ page }) => {
  const owner = await seedOwner();
  const admin = await seedSiteAdmin();
  const orgSlug = `r${owner.orgId.replaceAll('-', '').slice(0, 12)}`;
  await setOrganizationSlug(admin.principal, owner.orgId, orgSlug);
  const project = await seedProject(owner, 'Open board');
  await setProjectVisibility(owner.principal(), project.id, 'public');
  await postAs(owner.principal(), project.id, { title: 'Open thread', body: 'open body' });
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/sign-in/);
  const response = await page.goto(`/${orgSlug}/${project.slug}`);
  expect(response?.status()).toBe(200);
  expect(response?.headers()['x-robots-tag']).toContain('noindex');
  await expectNoindex(page);
  await expect(page.getByRole('link', { name: 'Active', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Newest', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Archived', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Urgent', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Pinned', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Search this project')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Post', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
  await expect(page.getByText('Open thread')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
});
