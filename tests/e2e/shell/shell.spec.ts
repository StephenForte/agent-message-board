import { expect, test } from '@playwright/test';
import { newId } from '../../../src/domain/kernel';
import {
  insertAgent, insertAudit, insertOrgAnnouncement, insertProject, insertRoot, publishSiteAnnouncement, seedPerson, signIn,
} from './helpers';

test.beforeEach(async ({ context }, info) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': `203.0.${info.workerIndex % 250}.${(info.line + 20) % 250}` });
});

test.describe.configure({ mode: 'serial', timeout: 60_000 });

test('no-org and suspended owners are routed to the account pages', async ({ page }) => {
  const none = await seedPerson({ name: 'No org person' });
  await signIn(page, none.email);
  await expect(page).toHaveURL(/\/no-organization$/);
  await expect(page.getByRole('heading', { name: 'No organization yet' })).toBeVisible();
  await page.goto('/');
  await expect(page).toHaveURL(/\/no-organization$/);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const suspended = await seedPerson({ name: 'Suspended person', orgStatus: 'suspended' });
  await signIn(page, suspended.email);
  await expect(page.getByRole('heading', { name: 'This organization is suspended' })).toBeVisible();
  await page.goto('/');
  await expect(page).toHaveURL(/\/suspended$/);
});

test('owner home shows projects, counts, and both announcement panels', async ({ page }) => {
  const owner = await seedPerson({ name: 'Home owner', orgStatus: 'active', admin: true });
  const projectId = await insertProject(owner.orgId!, owner.id, 'Home pilot project', 'home-pilot');
  await insertProject(owner.orgId!, owner.id, 'Home archived project', 'home-archived', 'archived');
  await insertRoot({ orgId: owner.orgId!, projectId, userId: owner.id, author: owner.name, title: 'Plain root' });
  await insertRoot({ orgId: owner.orgId!, projectId, userId: owner.id, author: owner.name, title: 'Urgent root', urgent: true });
  await insertRoot({
    orgId: owner.orgId!, projectId, userId: owner.id, author: owner.name, title: 'Old archived root',
    urgent: true, status: 'archived', lastActivityAt: new Date('2026-11-09T00:00:00.000Z'),
  });
  await insertAgent(owner.orgId!, 'home-agent', new Date('2026-11-08T15:04:00.000Z'));
  await publishSiteAnnouncement(owner.id, 'Home site title', 'Home site body for the panel');
  await insertOrgAnnouncement(owner.orgId!, owner.id, 'Home org title', 'Home org body for the panel');
  await signIn(page, owner.email);
  await expect(page.getByRole('heading', { name: 'Agent Message Board' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Home pilot project' })).toContainText('2 active threads');
  await expect(page.getByRole('article', { name: 'Home pilot project' })).toContainText('1 urgent');
  await expect(page.getByText('Home archived project')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Site announcement' })).toContainText('Home site body for the panel');
  await expect(page.getByRole('region', { name: 'Organization announcement' })).toContainText('Home org body for the panel');
  await expect(page.getByText('home-agent')).toBeVisible();
  await expect(page.getByText('Last seen 2026-11-08T15:04:00.000Z')).toBeVisible();
  await expect(page.getByText('It is not a live status.')).toBeVisible();
});

test('owner creates a project and archives it', async ({ page }) => {
  const owner = await seedPerson({ name: 'Project owner', orgStatus: 'active' });
  const slug = `pilot-${newId().slice(0, 8)}`;
  await signIn(page, owner.email);
  await page.goto('/projects');
  await page.getByLabel('Name', { exact: true }).fill('Created pilot');
  await page.getByLabel('Slug', { exact: true }).fill('Bad Slug');
  await page.getByLabel('Description', { exact: true }).fill('A place for agents');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'lowercase letters' })).toBeVisible();
  await page.getByLabel('Slug', { exact: true }).fill(slug);
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Project created.');
  await expect(page.getByRole('link', { name: 'Created pilot', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Settings for Created pilot', exact: true }).click();
  await expect(page.getByText('Archived projects are read-only for posting.')).toBeVisible();
  await page.getByRole('button', { name: 'Archive project', exact: true }).click();
  await expect(page.getByText(`Slug ${slug} · Archived`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore project', exact: true })).toBeVisible();
});

test('org announcement reports a conflict, then clear shows in the audit log', async ({ page }) => {
  const owner = await seedPerson({ name: 'Announcement owner', orgStatus: 'active' });
  await insertAudit(owner.orgId!, owner.id, 'agent.session_seen', { seen: true });
  await signIn(page, owner.email);
  const other = await page.context().newPage();
  await page.goto('/settings');
  await other.goto('/settings');
  await expect(page.getByText('Based on version 0.')).toBeVisible();
  await other.getByLabel('Title', { exact: true }).fill('Committed title');
  await other.getByLabel('Body', { exact: true }).fill('Committed **body**');
  await other.getByRole('button', { name: 'Save announcement', exact: true }).click();
  await expect(other.getByRole('status')).toContainText('Announcement saved.');
  await expect(other.getByText('Based on version 1.')).toBeVisible();
  await expect(other.getByRole('button', { name: 'Clear announcement', exact: true })).toBeVisible();
  await page.getByLabel('Title', { exact: true }).fill('Stale title');
  await page.getByLabel('Body', { exact: true }).fill('Stale body');
  await page.getByRole('button', { name: 'Save announcement', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Current version is 1' })).toBeVisible();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Stale title');
  await expect(page.getByRole('region', { name: 'Current organization announcement' })).toContainText('Committed title');
  await other.getByRole('button', { name: 'Clear announcement', exact: true }).click();
  await expect(other.getByRole('status')).toContainText('Announcement cleared.');
  await expect(other.getByText('No organization announcement.')).toBeVisible();
  await page.goto('/settings/audit');
  await expect(page.getByRole('cell', { name: 'announcement.set' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'announcement.clear' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'agent.session_seen' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Show session activity' }).click();
  await expect(page.getByRole('cell', { name: 'agent.session_seen' })).toBeVisible();
  await other.close();
});

test('site admin edits the site announcement and a non-admin receives 404', async ({ page }) => {
  expect((await page.goto('/admin/announcement'))?.status()).toBe(404);
  const admin = await seedPerson({ name: 'Site editor', admin: true });
  const owner = await seedPerson({ name: 'Ordinary owner', orgStatus: 'active' });
  await signIn(page, admin.email);
  await page.goto('/admin/announcement');
  await expect(page.getByRole('heading', { name: 'Site announcement', exact: true })).toBeVisible();
  const title = `Site title ${newId().slice(0, 8)}`;
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill(title);
  await page.getByRole('textbox', { name: 'Body', exact: true }).fill('Site body from the admin editor');
  await page.getByRole('button', { name: 'Save announcement', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Announcement saved.');
  await expect(page.getByRole('region', { name: 'Current site announcement' })).toContainText(title);
  await page.goto('/');
  await expect(page).toHaveURL(/\/no-organization$/);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn(page, owner.email);
  await expect(page.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
  expect((await page.goto('/admin/announcement'))?.status()).toBe(404);
});

test('two owners do not see each others projects, counts, announcements, or audit rows', async ({ page }) => {
  const alpha = await seedPerson({ name: 'Alpha owner', orgStatus: 'active', admin: true });
  const beta = await seedPerson({ name: 'Beta owner', orgStatus: 'active' });
  const alphaProject = await insertProject(alpha.orgId!, alpha.id, 'Isolation alpha project', 'iso-alpha');
  const betaProject = await insertProject(beta.orgId!, beta.id, 'Isolation beta project', 'iso-beta');
  await insertRoot({ orgId: alpha.orgId!, projectId: alphaProject, userId: alpha.id, author: alpha.name, title: 'Alpha root' });
  for (let index = 0; index < 4; index += 1) {
    await insertRoot({ orgId: beta.orgId!, projectId: betaProject, userId: beta.id, author: beta.name, title: `Beta root ${index}`, urgent: true });
  }
  await publishSiteAnnouncement(alpha.id, 'Shared site title', 'Shared site body');
  await insertOrgAnnouncement(alpha.orgId!, alpha.id, 'Alpha announcement', 'Alpha announcement body');
  await insertOrgAnnouncement(beta.orgId!, beta.id, 'Beta announcement', 'Beta announcement body');
  await insertAudit(alpha.orgId!, alpha.id, 'project.create', { marker: 'isolation-alpha-audit-marker' });
  await insertAudit(beta.orgId!, beta.id, 'project.create', { marker: 'isolation-beta-audit-marker' });
  await signIn(page, alpha.email);
  await expect(page.getByRole('article', { name: 'Isolation alpha project' })).toContainText('1 active threads');
  await expect(page.getByText('Isolation beta project')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Organization announcement' })).toContainText('Alpha announcement body');
  await expect(page.getByText('Beta announcement body')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Site announcement' })).toContainText('Shared site body');
  await page.goto('/settings/audit');
  await expect(page.getByText('isolation-alpha-audit-marker')).toBeVisible();
  await expect(page.getByText('isolation-beta-audit-marker')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn(page, beta.email);
  await expect(page.getByRole('article', { name: 'Isolation beta project' })).toContainText('4 active threads');
  await expect(page.getByRole('article', { name: 'Isolation beta project' })).toContainText('4 urgent');
  await expect(page.getByText('Isolation alpha project')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Organization announcement' })).toContainText('Beta announcement body');
  await expect(page.getByText('Alpha announcement body')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Site announcement' })).toContainText('Shared site body');
  await page.goto('/settings/audit');
  await expect(page.getByText('isolation-beta-audit-marker')).toBeVisible();
  await expect(page.getByText('isolation-alpha-audit-marker')).toHaveCount(0);
});
