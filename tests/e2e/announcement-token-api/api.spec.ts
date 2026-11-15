import { expect, test } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../../../src/db/client';
import * as schema from '../../../src/db/schema';
import { createToken } from '../../../src/domain/credentials';
import { setOrgAnnouncement, setSiteAnnouncement } from '../../../src/domain/announcements';
import { closeDb, expectNoInjection, seedOwner, seedProject, signIn } from '../board/helpers';

test.afterAll(async () => { await closeDb(); });

test('signed-out public page renders token-written hostile Markdown inertly and hides site and org announcements', async ({ page, request }) => {
  const owner = await seedOwner(), project = await seedProject(owner, 'Public snapshot');
  const db = createDatabase(process.env.AMB_E2E_DATABASE_URL!);
  const slug = `org${owner.orgId.replaceAll('-', '').slice(0, 16)}`;
  try {
    await db.db.update(schema.organizations).set({ slug }).where(eq(schema.organizations.id, owner.orgId));
    await db.db.update(schema.projects).set({ visibility: 'public' }).where(eq(schema.projects.id, project.id));
    await db.db.insert(schema.siteAdmins).values({ userId: owner.id });
    // The global site row can exist already; retain its version guard.
    const [current] = await db.db.select().from(schema.announcements).where(eq(schema.announcements.scope, 'site'));
    await setSiteAnnouncement({ ...owner.principal(), siteAdmin: true }, { title: 'Hidden site T27', body: 'Site secret T27', expectedVersion: current?.version ?? 0 });
    await setOrgAnnouncement(owner.principal(), { title: 'Hidden org T27', body: 'Org secret T27', expectedVersion: 0 });
    const token = await createToken(owner.principal(), { label: 'Public writer', scope: 'org', canSetProjectAnnouncements: true });
    // Keep secrets inside fetch; assertion diagnostics must not include request headers.
    const response = await request.put(`/api/v1/projects/${project.slug}/announcement`, {
      headers: { authorization: `Bearer ${token.secret}` }, data: { title: 'Public reference snapshot', body: 'Reference data\n\n<script>window.pwned=true</script>\n\n[bad](javascript:alert(1))\n\n<iframe src=x></iframe>' },
    });
    expect(response.status()).toBe(200);
    const viewed = await page.goto(`/${slug}/${project.slug}`);
    expect(viewed?.status()).toBe(200);
    const panel = page.getByRole('region', { name: 'Project announcement', exact: true });
    await expect(panel).toContainText('Public reference snapshot');
    await expect(panel).toContainText('Reference data');
    await expectNoInjection(page, '[aria-label="Project announcement"]');
    await expect(page.getByText('Site secret T27', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Org secret T27', { exact: true })).toHaveCount(0);
    expect(await panel.evaluate(el => Boolean(el.compareDocumentPosition(document.querySelector('#thread-list')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await db.db.update(schema.projects).set({ visibility: 'private' }).where(eq(schema.projects.id, project.id));
    expect((await page.goto(`/${slug}/${project.slug}`))?.status()).toBe(404);
    await expect(page.getByText('Reference data', { exact: true })).toHaveCount(0);
    const missing = await request.put(`/api/v1/projects/${project.slug}/announcement`, { data: { title: 'No bearer', body: '' } });
    expect(missing.status()).toBe(401);
  } finally { await db.pool.end(); }
});

test('owner grants announcement capability when issuing and replacing tokens and the list shows the flag', async ({ page }) => {
  const owner = await seedOwner();
  await signIn(page, owner.email);
  await page.goto('/tokens');
  const create = page.getByRole('region', { name: 'Create a token' });
  await create.getByLabel('Label', { exact: true }).fill('Snapshot CLI');
  await create.getByLabel('May set project announcements', { exact: true }).check();
  await create.getByRole('button', { name: 'Create token', exact: true }).click();
  await expect(create.getByRole('textbox', { name: 'Token secret', exact: true })).toBeVisible();
  await page.reload();
  const token = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Snapshot CLI', exact: true }) });
  await expect(token.locator('dt').filter({ hasText: 'May set project announcements' }).locator('+ dd')).toHaveText('Enabled');
  await token.getByLabel('May set project announcements', { exact: true }).uncheck();
  await token.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(token.getByRole('textbox', { name: 'Token secret', exact: true })).toBeVisible();
  await page.reload();
  const rows = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Snapshot CLI', exact: true }) });
  await expect(rows).toHaveCount(2);
  const flags = await rows.locator('dt').filter({ hasText: 'May set project announcements' }).locator('+ dd').allTextContents();
  expect(flags.sort()).toEqual(['Disabled', 'Enabled']);
  expect((await page.request.put('/api/v1/projects/unknown/announcement', { data: { title: 'Cookies only', body: '' } })).status()).toBe(401);
  await page.goto('/connect');
  await expect(page.getByLabel('May set project announcements', { exact: true })).toBeVisible();
});
