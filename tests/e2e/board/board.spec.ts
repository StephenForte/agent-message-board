import { expect, test, type Page, type Route } from '@playwright/test';
import { newId } from '../../../src/domain/kernel';
import { closeDb, archiveOwnedProject, archiveThread, expectNoInjection, postAs, seedAgent, seedOwner, seedProject, signIn } from './helpers';

test.beforeEach(async ({ context }, info) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': `198.51.${info.workerIndex % 250}.${info.line % 250}` });
});
test.afterAll(async () => {
  await closeDb();
});

const xssCorpus = [
  '<script>alert(1)</script>',
  '<img src=x onerror="alert(1)">',
  '<iframe src="https://evil.test"></iframe>',
  '[x](javascript:alert(1))',
  '[x](data:text/html,evil)',
  '[x](jav&#x61;script:alert(1))',
].join('\n\n');

function boardFilters(page: Page) {
  return page.locator('#board-filters');
}

async function applyFilters(page: Page, query: RegExp) {
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page).toHaveURL(query);
}

async function clearFilters(page: Page) {
  await page.getByRole('link', { name: 'Clear filters', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/[^/?#]+$/);
}

async function openNewPost(page: Page) {
  await page.locator('summary', { hasText: 'New post' }).click();
}

async function openFilters(page: Page) {
  await page.locator('summary', { hasText: 'Filters' }).click();
}

async function openBoard(page: Page, email: string, slug: string) {
  await signIn(page, email);
  await page.goto(`/projects/${slug}`);
  await expect(page.locator('#board-content')).toBeVisible();
}

test('posts a root from the handoff template with recipients and then a reply', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const owner = await seedOwner();
  const project = await seedProject(owner);
  await seedAgent(owner, 'reviewer');
  await openBoard(page, owner.email, project.slug);
  await openNewPost(page);
  await expect(page.getByText('Recipients are routing hints and are not private.')).toBeVisible();
  await page.getByRole('button', { name: 'Use handoff template', exact: true }).click();
  await expect(page.getByLabel('Body')).toHaveValue(/What changed/);
  await expect(page.getByLabel('Body')).toHaveValue(/Rationale/);
  await expect(page.getByLabel('Body')).toHaveValue(/Remaining work/);
  await expect(page.getByLabel('Body')).toHaveValue(/References/);
  await expect(page.locator('#new-root-form').getByLabel('Category', { exact: true })).toHaveValue('handoff');
  await page.getByLabel('Title', { exact: true }).fill('Handoff from the desk');
  await page.getByRole('checkbox', { name: 'reviewer', exact: true }).check();
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Handoff from the desk' })).toBeVisible();
  await expect(page.getByText('Category: handoff')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Recipients' })).toContainText('reviewer');
  await page.getByLabel('Body').fill('Reply from the human.');
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.getByText('Reply from the human.')).toBeVisible();
  await expect(page.getByText('Human: E2E owner').first()).toBeVisible();
});

test('urgent and pinned threads show in those sections', async ({ page }) => {
  const owner = await seedOwner();
  const project = await seedProject(owner);
  await openBoard(page, owner.email, project.slug);
  await openNewPost(page);
  await page.getByLabel('Title', { exact: true }).fill('Stand up');
  await page.getByLabel('Body').fill('Look at this first.');
  await page.getByRole('checkbox', { name: 'Urgent', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Pinned', exact: true }).check();
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await page.getByRole('link', { name: 'Back to the board', exact: true }).click();
  await expect(page.locator('#urgent-threads').getByRole('heading', { name: 'Stand up' })).toBeVisible();
  await expect(page.locator('#pinned-threads').getByRole('heading', { name: 'Stand up' })).toBeVisible();
});

test('archive hides a thread until the archived filter, and restore brings it back', async ({ page }) => {
  const owner = await seedOwner();
  const project = await seedProject(owner);
  const root = await postAs(owner.principal(), project.id, { title: 'Finished work', body: 'Done for now.' });
  await openBoard(page, owner.email, project.slug);
  await page.getByRole('link', { name: 'Finished work', exact: true }).click();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByText('Status: archived')).toBeVisible();
  await expect(page.locator('#change-history')).toContainText('status archived');
  await expect(page.getByText('Restore it first before replying.')).toBeVisible();
  await expect(page.locator('#reply-form').getByLabel('Body')).toBeDisabled();
  await page.getByRole('link', { name: 'Back to the board', exact: true }).click();
  await expect(page.locator('#thread-list').getByRole('heading', { name: 'Finished work' })).toHaveCount(0);
  await openFilters(page);
  await boardFilters(page).getByLabel('Status', { exact: true }).selectOption('archived');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.locator('#thread-list').getByRole('heading', { name: 'Finished work' })).toBeVisible();
  await page.getByRole('link', { name: 'Finished work', exact: true }).click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByText('Status: active')).toBeVisible();
  await page.goto(`/projects/${project.slug}`);
  await expect(page.locator('#thread-list').getByRole('heading', { name: 'Finished work' })).toBeVisible();
  expect(root.id).toBeTruthy();
});

test('a second tab sees a version conflict and can re-apply', async ({ page }) => {
  const owner = await seedOwner();
  const project = await seedProject(owner);
  const root = await postAs(owner.principal(), project.id, { title: 'Contested', body: 'Two people, one version.' });
  await openBoard(page, owner.email, project.slug);
  const url = `/projects/${project.slug}/threads/${root.id}`;
  await page.goto(url);
  const other = await page.context().newPage();
  await other.goto(url);
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByText('Status: archived')).toBeVisible();
  await other.getByRole('button', { name: 'Mark urgent', exact: true }).click();
  const conflict = other.getByRole('alert').filter({ hasText: 'This thread changed' });
  await expect(conflict).toContainText('status archived');
  await other.getByRole('button', { name: 'Re-apply', exact: true }).click();
  await expect(other.getByText('Urgent: yes')).toBeVisible();
  await expect(other.getByText('Status: archived')).toBeVisible();
  await other.close();
});

test('search finds a reply inside its root', async ({ page }) => {
  const owner = await seedOwner();
  const project = await seedProject(owner);
  const root = await postAs(owner.principal(), project.id, { title: 'Habitat notes', body: 'Roots stay put.' });
  await openBoard(page, owner.email, project.slug);
  await page.goto(`/projects/${project.slug}/threads/${root.id}`);
  await page.getByLabel('Body').fill('A zebra crossed the trail.');
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.goto(`/projects/${project.slug}`);
  await openFilters(page);
  await page.getByLabel('Search', { exact: true }).fill('zebra');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  const match = page.locator('#thread-list').getByRole('list', { name: 'Search matches' });
  await expect(match).toContainText('zebra');
  await expect(match).toContainText('Reply match');
  await expect(page.locator('#thread-list').getByRole('heading', { name: 'Habitat notes' })).toBeVisible();
});

test('each filter narrows the board', async ({ page }) => {
  const owner = await seedOwner();
  const project = await seedProject(owner);
  const agent = await seedAgent(owner, 'reviewer');
  await postAs(owner.principal(), project.id, { title: 'Filter note', body: 'plain note' });
  await postAs(owner.principal(), project.id, { title: 'Filter decision', body: 'a decision', category: 'decision' });
  await postAs(owner.principal(), project.id, { title: 'Filter urgent', body: 'needs eyes', urgent: true });
  await postAs(owner.principal(), project.id, { title: 'Filter pinned', body: 'keep this', pinned: true });
  const archived = await postAs(owner.principal(), project.id, { title: 'Filter archived', body: 'old news' });
  await archiveThread(owner, archived.id);
  await postAs(agent.principal, project.id, {
    title: 'Filter agent', body: 'from the agent', category: 'finding', recipients: [agent.agentId],
  });
  await openBoard(page, owner.email, project.slug);
  const list = page.locator('#thread-list');
  await expect(list.getByRole('heading', { name: 'Filter note' })).toBeVisible();
  await expect(list.getByRole('heading', { name: 'Filter archived' })).toHaveCount(0);

  await openFilters(page);
  await boardFilters(page).getByLabel('Status', { exact: true }).selectOption('archived');
  await applyFilters(page, /status=archived/);
  await expect(list.getByRole('heading', { name: 'Filter archived' })).toBeVisible();
  await expect(list.getByRole('heading', { name: 'Filter note' })).toHaveCount(0);

  await clearFilters(page);
  await openFilters(page);
  await boardFilters(page).getByLabel('Category', { exact: true }).selectOption('decision');
  await applyFilters(page, /category=decision/);
  await expect(list.getByRole('heading', { name: 'Filter decision' })).toBeVisible();
  await expect(list.getByRole('heading', { name: 'Filter note' })).toHaveCount(0);

  await clearFilters(page);
  await openFilters(page);
  await boardFilters(page).getByLabel('Author', { exact: true }).selectOption('reviewer');
  await applyFilters(page, /author=/);
  await expect(list.getByRole('heading', { name: 'Filter agent' })).toBeVisible();
  await expect(list.getByRole('heading', { name: 'Filter note' })).toHaveCount(0);

  await clearFilters(page);
  await openFilters(page);
  await boardFilters(page).getByLabel('Author', { exact: true }).selectOption('human');
  await applyFilters(page, /author=human/);
  await expect(list.getByRole('heading', { name: 'Filter note' })).toBeVisible();
  await expect(list.getByRole('heading', { name: 'Filter agent' })).toHaveCount(0);

  await clearFilters(page);
  await openFilters(page);
  await boardFilters(page).getByLabel('Recipient', { exact: true }).selectOption('reviewer');
  await applyFilters(page, /recipient=/);
  await expect(list.getByRole('heading', { name: 'Filter agent' })).toBeVisible();
  await expect(list.getByRole('heading', { name: 'Filter note' })).toHaveCount(0);

  await clearFilters(page);
  await openFilters(page);
  await boardFilters(page).getByLabel('Urgent', { exact: true }).selectOption('yes');
  await applyFilters(page, /urgent=yes/);
  await expect(list.getByRole('heading', { name: 'Filter urgent' })).toBeVisible();
  await expect(list.getByRole('heading', { name: 'Filter note' })).toHaveCount(0);

  await clearFilters(page);
  await openFilters(page);
  await boardFilters(page).getByLabel('Pinned', { exact: true }).selectOption('yes');
  await applyFilters(page, /pinned=yes/);
  await expect(list.getByRole('heading', { name: 'Filter pinned' })).toBeVisible();
  await expect(list.getByRole('heading', { name: 'Filter note' })).toHaveCount(0);
});

test('an archived project is read-only', async ({ page }) => {
  const owner = await seedOwner();
  const project = await seedProject(owner);
  await postAs(owner.principal(), project.id, { title: 'Left in place', body: 'Still readable.' });
  await archiveOwnedProject(owner, project.id);
  await openBoard(page, owner.email, project.slug);
  await expect(page.getByRole('status').filter({ hasText: 'read-only' })).toBeVisible();
  await expect(page.locator('#new-root-form')).toHaveCount(0);
  await page.getByRole('link', { name: 'Left in place', exact: true }).click();
  await expect(page.getByText('Still readable.')).toBeVisible();
  await expect(page.locator('#reply-form')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
});

test('hostile Markdown does not execute on the board, thread, search results, or preview', async ({ page }) => {
  const owner = await seedOwner();
  const project = await seedProject(owner);
  let dialog = false;
  page.on('dialog', async (popup) => {
    dialog = true;
    await popup.dismiss();
  });
  await openBoard(page, owner.email, project.slug);
  await openNewPost(page);
  await page.getByLabel('Title', { exact: true }).fill('XSS <script>alert(1)</script>');
  await page.getByLabel('Body').fill(xssCorpus);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('#composer-preview')).toBeVisible();
  await expectNoInjection(page, '#composer-preview');
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.locator('#thread-content')).toBeVisible();
  await expectNoInjection(page, '#thread-content');
  await page.getByLabel('Body').fill(xssCorpus);
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.locator('#thread-content article')).toHaveCount(2);
  await expectNoInjection(page, '#thread-content');
  await page.goto(`/projects/${project.slug}`);
  await openFilters(page);
  await page.getByLabel('Search', { exact: true }).fill('alert');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.locator('#board-content')).toContainText('alert');
  await expectNoInjection(page, '#board-content');
  expect(dialog).toBe(false);
});

test('submitting the same rendered form twice creates one root', async ({ page }) => {
  const owner = await seedOwner();
  const project = await seedProject(owner);
  await openBoard(page, owner.email, project.slug);
  await openNewPost(page);
  const title = `Once ${newId()}`;
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('Body').fill('Same body for both submits.');
  const key = await page.locator('#new-root-form input[name="idempotencyKey"]').inputValue();
  const posts: string[] = [];
  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    if (request.method() === 'POST' && request.headers()['next-action']) posts.push(request.postData() ?? '');
    await route.continue();
  });
  await page.locator('#new-root-form').evaluate((form: HTMLFormElement) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect.poll(() => posts.length, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
  expect(posts.filter((body) => body.includes(key)).length).toBeGreaterThanOrEqual(2);
  await page.goto(`/projects/${project.slug}`);
  await expect(page.locator('#thread-list').getByRole('heading', { name: title, exact: true })).toHaveCount(1);
});

test('a draft survives a failed submit and the byte limit', async ({ page }) => {
  const owner = await seedOwner();
  const project = await seedProject(owner);
  await openBoard(page, owner.email, project.slug);
  await openNewPost(page);
  await page.getByLabel('Title', { exact: true }).fill('Too big');
  await page.getByLabel('Body').fill('a'.repeat(32769));
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '32768' })).toBeVisible();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Too big');
  await expect(page.getByLabel('Body')).toHaveValue('a'.repeat(32769));

  await page.getByLabel('Title', { exact: true }).fill('Keep the title');
  await page.getByLabel('Body').fill('Keep the body');
  await page.route('**/*', (route) => {
    if (route.request().method() === 'POST') return route.abort();
    return route.continue();
  });
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'still here' })).toBeVisible();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Keep the title');
  await expect(page.getByLabel('Body')).toHaveValue('Keep the body');
});

test('another organization slug and thread id are not found', async ({ page }) => {
  const owner = await seedOwner();
  const other = await seedOwner();
  const project = await seedProject(owner);
  const hidden = await seedProject(other, 'Hidden');
  const root = await postAs(other.principal(), hidden.id, { title: 'Secret', body: 'Not yours.' });
  await openBoard(page, owner.email, project.slug);
  expect((await page.goto(`/projects/${hidden.slug}`))?.status()).toBe(404);
  expect((await page.goto(`/projects/${project.slug}/threads/${root.id}`))?.status()).toBe(404);
});

test('the board pages threads with nextCursor', async ({ page }) => {
  test.setTimeout(60_000);
  const owner = await seedOwner();
  const project = await seedProject(owner);
  for (let index = 1; index <= 21; index += 1) {
    await postAs(owner.principal(), project.id, { title: `Item ${String(index).padStart(2, '0')}`, body: `Body ${index}` });
  }
  await openBoard(page, owner.email, project.slug);
  const list = page.locator('#thread-list');
  await expect(list.getByRole('heading', { name: 'Item 21' })).toBeVisible();
  await expect(list.getByRole('heading', { name: 'Item 01' })).toHaveCount(0);
  await page.locator('#thread-list-next').click();
  await expect(list.getByRole('heading', { name: 'Item 01' })).toBeVisible();
  await expect(list.getByRole('heading', { name: 'Item 21' })).toHaveCount(0);
});
