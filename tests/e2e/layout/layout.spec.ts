import { expect, test } from '@playwright/test';
import { archiveOwnedProject, closeDb, postAs, seedOwner, seedProject, signIn } from '../board/helpers';

test.beforeEach(async ({ context }, info) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': `198.18.${info.workerIndex % 250}.${(info.line + 7) % 250}` });
});

test.afterAll(async () => {
  await closeDb();
});

test('sidebar, tabs, rows, project search, and the narrow menu', async ({ page }) => {
  const owner = await seedOwner();
  const project = await seedProject(owner, 'Layout pilot');
  await seedProject(owner, 'Layout spare');
  const shelved = await seedProject(owner, 'Layout shelved');
  await archiveOwnedProject(owner, shelved.id);
  await postAs(owner.principal(), project.id, { title: 'Quiet note', body: 'Nothing pressing.' });
  const urgent = await postAs(owner.principal(), project.id, { title: 'Needs eyes', body: 'A zebra crossed the layout trail.', urgent: true });
  await signIn(page, owner.email);
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav.getByRole('link', { name: 'Layout pilot', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Layout spare', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Layout shelved', exact: true })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Tokens', exact: true })).toBeVisible();

  await page.goto(`/projects/${project.slug}`);
  await expect(page.locator('#board-content')).toBeVisible();
  await page.getByRole('navigation', { name: 'Thread views' }).getByRole('link', { name: 'Urgent', exact: true }).click();
  await expect(page).toHaveURL(/urgent=yes/);
  await expect(page.locator('#thread-list').getByRole('heading', { name: 'Needs eyes' })).toBeVisible();
  await expect(page.locator('#thread-list').getByRole('heading', { name: 'Quiet note' })).toHaveCount(0);

  await page.locator('#thread-list').getByRole('link', { name: 'Needs eyes', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/threads/${urgent.id}`));
  await expect(page.getByRole('heading', { name: 'Needs eyes' })).toBeVisible();

  await page.goto(`/projects/${project.slug}`);
  await page.getByLabel('Search messages', { exact: true }).fill('zebra');
  await page.getByRole('button', { name: 'Search messages', exact: true }).click();
  await expect(page).toHaveURL(/q=zebra/);
  await expect(page.locator('#thread-list').getByRole('heading', { name: 'Needs eyes' })).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/projects/${project.slug}`);
  await expect(page.locator('#thread-list').getByRole('heading', { name: 'Quiet note' })).toBeVisible();
  const firstRow = page.locator('#urgent-threads a, #thread-list a').first();
  await expect(firstRow).toBeInViewport();
  const shots = process.env.T19_SCREENSHOTS;
  if (shots) {
    await page.screenshot({ path: `${shots}/project-1440.png` });
    await page.locator('#thread-list').getByRole('link', { name: 'Quiet note', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Quiet note' })).toBeVisible();
    await page.screenshot({ path: `${shots}/thread-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/projects/${project.slug}`);
    await expect(page.locator('#thread-list').getByRole('heading', { name: 'Quiet note' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
    await page.screenshot({ path: `${shots}/project-375.png`, fullPage: true });
  }

  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/projects/${project.slug}`);
  await expect(nav).toBeHidden();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(nav.getByRole('link', { name: 'Layout pilot', exact: true })).toBeVisible();
});
