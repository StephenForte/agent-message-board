import { expect, test } from '@playwright/test';
import { createToken } from '../../../src/domain/credentials';
import { newId } from '../../../src/domain/kernel';
import { listThreads } from '../../../src/domain/messages';
import { closeDb, expectNoInjection, seedOwner, seedProject, signIn } from '../board/helpers';
import { seedPerson, signIn as signInPerson } from '../shell/helpers';

test.afterAll(async () => { await closeDb(); });
test.beforeEach(async ({ context }, info) => {
  await context.setExtraHTTPHeaders({ 'x-forwarded-for': `198.18.${info.workerIndex % 250}.${info.line % 250}` });
});
async function mcp(secret: string, name: string, args: Record<string, unknown>) {
  const response = await fetch('http://127.0.0.1:3100/api/mcp', { method: 'POST', headers: {
    authorization: `Bearer ${secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const json = await response.json();
  expect(json.result.isError).not.toBe(true);
  return json.result.structuredContent;
}

test('hostile MCP Markdown stays inert on the browser board and thread', async ({ page }) => {
  const owner = await seedOwner(); const project = await seedProject(owner);
  const issued = await createToken(owner.principal(), { label: 'injection', scope: 'org' });
  const connected = await mcp(issued.secret, 'connect_agent', { name: 'hostile-markdown' });
  const body = '<script>alert("script")</script>\n\n[bad](javascript:alert(1)) [data](data:text/html,<script>alert(1)</script>)\n\n<img src=x onerror="alert(1)">\n\n<iframe src="javascript:alert(1)"></iframe>\n\n**visible hostile fixture**';
  const root = await mcp(issued.secret, 'post_message', { session_id: connected.sessionId, project_id: project.id,
    title: 'MCP hostile fixture', body, urgent: true, idempotency_key: newId() });
  let dialogs = 0;
  page.on('dialog', async dialog => { dialogs++; await dialog.dismiss(); });
  await signIn(page, owner.email);
  await page.goto(`/projects/${project.slug}`);
  await expect(page.locator('#board-content')).toContainText('MCP hostile fixture');
  await expectNoInjection(page, '#board-content');
  await page.goto(`/projects/${project.slug}/threads/${root.id}`);
  await expect(page.locator('#thread-content')).toContainText('visible hostile fixture');
  await expectNoInjection(page, '#thread-content');
  expect(dialogs).toBe(0);
});

test('foreign Origin server action is rejected and cannot create a thread', async ({ page }) => {
  const owner = await seedOwner(); const project = await seedProject(owner);
  await signIn(page, owner.email); await page.goto(`/projects/${project.slug}`);
  const title = `csrf-probe-${newId()}`;
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('Body', { exact: true }).fill('foreign-origin-body');
  let captured: { headers: Record<string, string>; body: Buffer } | undefined;
  await page.route('**/*', async route => {
    const req = route.request();
    if (req.method() === 'POST' && req.headers()['next-action']) {
      captured = { headers: await req.allHeaders(), body: req.postDataBuffer()! };
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect.poll(() => !!captured).toBe(true);
  // Replay the authentic action and cookies over raw HTTP so Chromium cannot rewrite Origin.
  const headers: Record<string, string> = { ...captured!.headers, origin: 'https://foreign.example', host: '127.0.0.1:3100' };
  delete headers['content-length'];
  const response = await fetch(`http://127.0.0.1:3100/projects/${project.slug}`, {
    method: 'POST', headers, body: new Uint8Array(captured!.body), redirect: 'manual',
  });
  expect(response.status).toBeGreaterThanOrEqual(400);
  await response.text();
  expect((await listThreads(owner.principal(), { projectIds: [project.id], query: title })).totalCount).toBe(0);
  // Positive control: the same authentic action succeeds with the raw HTTP server Origin.
  const allowed = await fetch(`http://127.0.0.1:3100/projects/${project.slug}`, {
    method: 'POST', headers: { ...headers, origin: 'http://127.0.0.1:3100' },
    body: new Uint8Array(captured!.body), redirect: 'manual',
  });
  await allowed.text(); expect(allowed.status).toBeLessThan(400);
  expect((await listThreads(owner.principal(), { projectIds: [project.id], query: title })).totalCount).toBe(1);

});

test('owner guessed foreign project thread token and agent pages match absent objects', async ({ page }) => {
  const a = await seedOwner(); const b = await seedOwner(); const project = await seedProject(b);
  const issued = await createToken(b.principal(), { label: 'private-token-label', scope: 'org' });
  const connected = await mcp(issued.secret, 'connect_agent', { name: 'private-agent-name' });
  const root = await mcp(issued.secret, 'post_message', { session_id: connected.sessionId, project_id: project.id,
    title: 'private-thread-title', body: 'private-thread-body', idempotency_key: newId() });
  const ownProject = await seedProject(a);
  await signIn(page, a.email);
  for (const [real, absent] of [
    [`/projects/${project.slug}`, `/projects/missing-${newId()}`],
    [`/projects/${ownProject.slug}/threads/${root.id}`, `/projects/${ownProject.slug}/threads/${newId()}`],
    [`/tokens/${issued.token.id}`, `/tokens/${newId()}`],
    [`/agents/${connected.agent.id}`, `/agents/${newId()}`],
  ]) {
    const realResponse = await page.goto(real); const realText = await page.locator('body').innerText();
    const absentResponse = await page.goto(absent); const absentText = await page.locator('body').innerText();
    expect(realResponse?.status()).toBe(404); expect(absentResponse?.status()).toBe(404);
    expect(realText).toBe(absentText);
    for (const marker of [issued.secret, 'private-token-label', 'private-agent-name', 'private-thread-title', 'private-thread-body']) expect(realText.includes(marker)).toBe(false);
  }
});

test('admin without ownership and verified no-org user reach no browser content operations', async ({ page }) => {
  const owner = await seedOwner(); const project = await seedProject(owner, `Private project ${newId()}`);
  for (const admin of [true, false]) {
    const person = await seedPerson({ name: 'No owner', admin });
    await signInPerson(page, person.email);
    for (const path of ['/', '/projects', `/projects/${project.slug}`, '/tokens', '/agents', '/settings']) {
      await page.goto(path); await expect(page).toHaveURL(/\/no-organization$/);
      expect((await page.locator('main').innerText()).includes(project.name)).toBe(false);
    }
    await page.context().clearCookies();
  }
});

test('browser cookies cannot invoke MCP tools and human posts cannot choose another author', async ({ page }) => {
  const owner = await seedOwner(); const other = await seedOwner(); const project = await seedProject(owner);
  await signIn(page, owner.email);
  const response = await page.request.post('/api/mcp', { data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'connect_agent', arguments: { name: 'forged' } } } });
  expect(response.status()).toBe(401);
  await page.goto(`/projects/${project.slug}`);
  const title = `Own attribution ${newId()}`;
  await page.getByLabel('Title', { exact: true }).fill(title); await page.getByLabel('Body', { exact: true }).fill('attribution-body');
  await page.locator('#new-root-form').evaluate((form, userId) => {
    const input = document.createElement('input'); input.type = 'hidden'; input.name = 'authorUserId'; input.value = userId; form.append(input);
  }, other.id);
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.locator('#thread-content')).toContainText(title);
  const rows = await listThreads(owner.principal(), { projectIds: [project.id], query: title });
  expect(rows.items).toHaveLength(1); expect(rows.items[0].authorUserId).toBe(owner.id);
});
