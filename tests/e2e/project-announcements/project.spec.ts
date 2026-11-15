import { expect, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { hashPassword } from 'better-auth/crypto';
import { createDatabase } from '../../../src/db/client';
import * as schema from '../../../src/db/schema';
import { newId } from '../../../src/domain/kernel';
import { setProjectAnnouncement } from '../../../src/domain/announcements';
import { closeDb, expectNoInjection, password, seedOwner, seedProject, signIn } from '../board/helpers';

test.afterAll(async () => { await closeDb(); });

test('owner saves project announcement, stale save keeps draft, hostile Markdown is inert, clear removes panel', async ({ page, context }) => {
  const owner = await seedOwner();
  const project = await seedProject(owner, 'Project announcements');
  const settings = `/projects/${project.slug}/settings`;
  await signIn(page, owner.email);
  await page.goto(settings);
  const editor = page.getByRole('region', { name: 'Project announcement settings', exact: true });
  await editor.getByLabel('Title', { exact: true }).fill('Release context');
  await editor.getByRole('textbox', { name: /^Body/ }).fill('Use the new project workflow.\n\n<script>window.pwned=true</script>\n\n[bad](javascript:alert(1))\n\n<iframe src=x></iframe>');
  await editor.getByRole('button', { name: 'Save announcement', exact: true }).click();
  await expect(editor.getByRole('status')).toHaveText('Announcement saved.');
  const stale = await context.newPage();
  try {
    await stale.goto(settings);
    const staleEditor = stale.getByRole('region', { name: 'Project announcement settings', exact: true });
    await staleEditor.getByLabel('Title', { exact: true }).fill('My preserved draft');
    await staleEditor.getByRole('textbox', { name: /^Body/ }).fill('Draft body');
    await editor.getByLabel('Title', { exact: true }).fill('New release context');
    await editor.getByRole('button', { name: 'Save announcement', exact: true }).click();
    await expect(editor.getByText('Based on version 2.', { exact: true })).toBeVisible();
    await staleEditor.getByRole('button', { name: 'Save announcement', exact: true }).click();
    await expect(staleEditor.getByRole('alert')).toContainText('Current version is 2');
    await expect(staleEditor.getByRole('alert')).toContainText('published');
    await expect(staleEditor.getByLabel('Title', { exact: true })).toHaveValue('My preserved draft');
    await expect(staleEditor.getByRole('textbox', { name: /^Body/ })).toHaveValue('Draft body');
  } finally { await stale.close(); }
  await page.goto(`/projects/${project.slug}`);
  const panel = page.getByRole('region', { name: 'Project announcement', exact: true });
  await expect(panel.getByRole('heading', { name: 'New release context' })).toBeVisible();
  await expect(panel).toContainText('Version 2');
  await expect(panel).toContainText('Human, E2E owner');
  await expectNoInjection(page, '[aria-label="Project announcement"]');
  await page.screenshot({ path: 'tests/e2e/project-announcements/project-board.png', fullPage: true });
  await page.goto(`/projects/${project.slug}/briefing`);
  await expect(page.getByRole('region', { name: 'Project announcement' })).toContainText('New release context');
  await page.goto(settings);
  await page.getByRole('button', { name: 'Clear announcement', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Announcement cleared.');
  await expect(page.getByRole('region', { name: 'Revision history' })).toContainText('Cleared');
  await page.goto(`/projects/${project.slug}`);
  await expect(page.getByRole('region', { name: 'Project announcement', exact: true })).toHaveCount(0);
});

test('member reads project panel and gets 404 on settings; public page shows project announcement and org home omits it', async ({ page, browser }) => {
  const owner = await seedOwner();
  const project = await seedProject(owner, 'Member announcements');
  await setProjectAnnouncement(owner.principal(), { projectId: project.id, title: 'Members can read', body: 'Private project announcement body', expectedVersion: 0 });
  const db = createDatabase(process.env.AMB_E2E_DATABASE_URL!);
  const memberId = newId(), email = `${newId()}@example.com`;
  const orgSlug = `o${newId().replaceAll('-', '').slice(0, 12)}`;
  try {
    await db.db.insert(schema.user).values({ id: memberId, name: 'Announcement member', email, emailVerified: true });
    await db.db.insert(schema.account).values({ id: newId(), userId: memberId, accountId: memberId, providerId: 'credential', password: await hashPassword(password) });
    await db.db.insert(schema.orgMembers).values({ id: newId(), orgId: owner.orgId, userId: memberId });
    await db.db.update(schema.organizations).set({ slug: orgSlug }).where(eq(schema.organizations.id, owner.orgId));
    await db.db.update(schema.projects).set({ visibility: 'public' }).where(eq(schema.projects.id, project.id));
  } finally { await db.pool.end(); }
  await signIn(page, email);
  await page.goto(`/projects/${project.slug}`);
  await expect(page.getByRole('region', { name: 'Project announcement', exact: true })).toContainText('Members can read');
  const denied = await page.goto(`/projects/${project.slug}/settings`);
  expect(denied?.status()).toBe(404);
  await page.goto('/');
  await expect(page.getByText('Private project announcement body')).toHaveCount(0);
  const anonymous = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const visitor = await anonymous.newPage();
    await visitor.goto(`/${orgSlug}/${project.slug}`);
    await expect(visitor.getByRole('heading', { name: project.name })).toBeVisible();
    await expect(visitor.getByRole('region', { name: 'Project announcement', exact: true })).toContainText('Private project announcement body');
    expect((await visitor.goto(`/projects/${project.slug}/settings`))?.url()).toContain('/sign-in');
  } finally { await anonymous.close(); }
});
