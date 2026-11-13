import { hashPassword } from 'better-auth/crypto';
import { expect, type Page } from '@playwright/test';
import { createDatabase, closeDb } from '../../../src/db/client';
import { user, account } from '../../../src/db/schema/auth';
import { organizations } from '../../../src/db/schema/org';
import { authenticateBearer, connectAgent, createToken, resolveAgentSession } from '../../../src/domain/credentials';
import { newId, withOrgBootstrapTx, type AgentPrincipal, type HumanPrincipal } from '../../../src/domain/kernel';
import { postRoot, updateRootFlags } from '../../../src/domain/messages';
import { archiveProject, createProject } from '../../../src/domain/projects';

const databaseUrl = process.env.AMB_E2E_DATABASE_URL;
if (!databaseUrl) throw new Error('AMB_E2E_DATABASE_URL is required');
process.env.DATABASE_URL = databaseUrl;

export const password = 'synthetic-e2e-password';
export { closeDb };

type Category = 'note' | 'finding' | 'decision' | 'blocker' | 'handoff';

export function humanPrincipal(userId: string, orgId: string): HumanPrincipal {
  return { kind: 'human', userId, orgId, role: orgId ? 'owner' : null, siteAdmin: false, interface: 'web', requestId: newId() };
}

export async function seedOwner() {
  const runtime = createDatabase(databaseUrl!);
  const id = newId();
  const email = `${id}@example.com`;
  const orgId = newId();
  try {
    await runtime.db.insert(user).values({ id, email, name: 'E2E owner', emailVerified: true });
    await runtime.db.insert(account).values({
      id: newId(), userId: id, accountId: id, providerId: 'credential', password: await hashPassword(password),
    });
    await withOrgBootstrapTx(orgId, async (tx) => {
      await tx.insert(organizations).values({ id: orgId, name: 'E2E org', ownerUserId: id, status: 'active' });
    }, runtime.db);
  } finally {
    await runtime.pool.end();
  }
  return { id, email, orgId, principal: () => humanPrincipal(id, orgId) };
}

export async function seedProject(owner: { principal: () => HumanPrincipal }, name = 'Board') {
  const slug = `b${newId().replaceAll('-', '').slice(0, 12)}`;
  return createProject(owner.principal(), { name, slug, idempotencyKey: newId() });
}

export async function seedAgent(owner: { principal: () => HumanPrincipal }, name: string) {
  const issued = await createToken(owner.principal(), { label: name, scope: 'org' });
  const bearer = await authenticateBearer(`Bearer ${issued.secret}`, { requestId: newId(), interface: 'mcp' });
  const connected = await connectAgent(bearer, { name });
  const principal = await resolveAgentSession(bearer, connected.sessionId);
  return { agentId: connected.agent.id, name: connected.agent.name, principal };
}

export async function postAs(actor: HumanPrincipal | AgentPrincipal, projectId: string, input: {
  title: string; body: string; category?: Category; urgent?: boolean; pinned?: boolean; recipients?: string[];
}) {
  return postRoot({ ...actor, requestId: newId() }, {
    projectId, title: input.title, body: input.body, category: input.category ?? 'note',
    urgent: input.urgent ?? false, pinned: input.pinned ?? false, recipients: input.recipients ?? [],
    idempotencyKey: newId(),
  });
}

export async function archiveThread(owner: { principal: () => HumanPrincipal }, rootId: string, expectedVersion = 1) {
  return updateRootFlags(owner.principal(), { rootId, expectedVersion, status: 'archived', idempotencyKey: newId() });
}

export async function archiveOwnedProject(owner: { principal: () => HumanPrincipal }, projectId: string) {
  return archiveProject(owner.principal(), projectId);
}

export async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('https://localhost:3101/');
}

export async function expectNoInjection(page: Page, selector: string) {
  const report = await page.locator(selector).evaluate((root) => {
    const inline = [...root.querySelectorAll('*')].filter((element) => [...element.attributes].some((attribute) => /^on/i.test(attribute.name))).length;
    const badLink = [...root.querySelectorAll('a')].filter((anchor) => /^(javascript|data):/i.test(anchor.getAttribute('href') ?? '')).length;
    const documentHandlers = [...document.querySelectorAll('*')].filter((element) => [...element.attributes].some((attribute) => /^on/i.test(attribute.name))).length;
    return {
      scripts: root.querySelectorAll('script').length,
      iframes: root.querySelectorAll('iframe').length,
      inline,
      badLink,
      documentHandlers,
    };
  });
  expect(report).toEqual({ scripts: 0, iframes: 0, inline: 0, badLink: 0, documentHandlers: 0 });
}
