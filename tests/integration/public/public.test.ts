import { readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, expect, test } from 'vitest';
import { user } from '../../../src/db/schema/auth';
import { agentTokens, agents } from '../../../src/db/schema/identity';
import { messages, messageRecipients } from '../../../src/db/schema/messages';
import { organizations } from '../../../src/db/schema/org';
import { auditRecords, events } from '../../../src/db/schema/ops';
import { projects } from '../../../src/db/schema/projects';
import { agentSessions } from '../../../src/db/schema/sessions';
import { siteAdmins } from '../../../src/db/schema/site-admins';
import { DomainError, newId, withOrgBootstrapTx, withOrgTx, type AgentPrincipal, type HumanPrincipal } from '../../../src/domain/kernel';
import { setOrganizationSlug } from '../../../src/domain/organizations';
import { createProject, listProjects, setProjectVisibility } from '../../../src/domain/projects';
import { getPublicThread, listPublicThreads } from '../../../src/domain/publicboard';
import { openDatabase, runtimeUrl, sha256Hex, tokenPrefix } from '../helpers';

const runtime = openDatabase(runtimeUrl(), 6);
const db = runtime.db;
process.env.DATABASE_URL = runtimeUrl();
afterAll(async () => { await runtime.pool.end(); });

function ownerOf(userId: string, orgId: string): HumanPrincipal {
  return { kind: 'human', userId, orgId, siteAdmin: false, interface: 'web', requestId: `t20-${userId}` };
}
function adminOf(userId: string): HumanPrincipal {
  return { kind: 'human', userId, orgId: null, siteAdmin: true, interface: 'web', requestId: `t20-admin-${userId}` };
}

async function catchDomain(run: () => Promise<unknown>): Promise<DomainError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a domain error');
}

function keysOf(value: unknown, found = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, found);
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    found.add(key);
    keysOf(child, found);
  }
  return found;
}

async function seedOrg(name: string) {
  const userId = newId();
  const orgId = newId();
  const projectId = newId();
  const otherProjectId = newId();
  const tokenId = newId();
  const agentId = newId();
  const recipientId = newId();
  const sessionId = newId();
  const prefix = tokenPrefix();
  const rootId = newId();
  const replyId = newId();
  const archivedId = newId();
  const otherRootId = newId();
  await db.insert(user).values({ id: userId, name: 'Owner', email: `${userId}@example.com`, emailVerified: true });
  await withOrgBootstrapTx(orgId, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name, ownerUserId: userId, status: 'active' });
    await tx.insert(projects).values({
      id: projectId, orgId, slug: 'board', name: 'Board', description: 'Visible board', status: 'active',
      createdByKind: 'human', createdByUserId: userId,
    });
    await tx.insert(projects).values({
      id: otherProjectId, orgId, slug: 'other', name: 'Other', status: 'active',
      createdByKind: 'human', createdByUserId: userId,
    });
    await tx.insert(agentTokens).values({
      id: tokenId, orgId, label: 'primary', prefix, tokenHash: sha256Hex(), scope: 'org', createdByUserId: userId,
    });
    await tx.insert(agents).values({ id: agentId, orgId, name: 'field-agent' });
    await tx.insert(agents).values({ id: recipientId, orgId, name: 'recipient-only' });
    await tx.insert(agentSessions).values({ id: sessionId, orgId, agentId, tokenId, clientLabel: 'test' });
    await tx.insert(messages).values({
      id: rootId, orgId, projectId, title: 'Public thread', body: 'zebrapublic body', category: 'note', status: 'active',
      urgent: true, pinned: false, version: 1, lastActivityAt: new Date('2026-11-03T00:00:00.000Z'),
      authorKind: 'human', authorUserId: userId, authorDisplayName: 'Owner',
    });
    await tx.insert(messageRecipients).values({ orgId, messageId: rootId, agentId: recipientId });
    await tx.insert(messages).values({
      id: replyId, orgId, projectId, rootId, body: 'reply visible text', authorKind: 'agent', authorTokenId: tokenId,
      authorAgentId: agentId, authorSessionId: sessionId, authorDisplayName: 'field-agent',
    });
    await tx.insert(messages).values({
      id: archivedId, orgId, projectId, title: 'Archived secret thread', body: 'archivedsecretword', category: 'note',
      status: 'archived', urgent: false, pinned: false, version: 1, lastActivityAt: new Date('2026-11-04T00:00:00.000Z'),
      authorKind: 'human', authorUserId: userId, authorDisplayName: 'Owner',
    });
    await tx.insert(messages).values({
      id: otherRootId, orgId, projectId: otherProjectId, title: 'Other project thread', body: 'other project body',
      category: 'note', status: 'active', urgent: false, pinned: false, version: 1, lastActivityAt: new Date('2026-11-01T00:00:00.000Z'),
      authorKind: 'human', authorUserId: userId, authorDisplayName: 'Owner',
    });
  }, db);
  const agent: AgentPrincipal = {
    kind: 'agent', orgId, tokenId, scope: 'org', projectIds: 'all', canCreateProjects: false,
    agentId, sessionId, interface: 'mcp', requestId: `t20-agent-${orgId}`,
  };
  return {
    userId, orgId, projectId, otherProjectId, tokenId, agentId, recipientId, sessionId, prefix, rootId, replyId,
    archivedId, otherRootId, owner: ownerOf(userId, orgId), agent,
  };
}

test('public list and thread hide private fields and every non-public case is the same error', async () => {
  const role = await runtime.pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
  );
  expect(role.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
  const world = await seedOrg('t20-read');
  const adminId = newId();
  await db.insert(user).values({ id: adminId, name: 'Admin', email: `${adminId}@example.com`, emailVerified: true });
  await db.insert(siteAdmins).values({ userId: adminId });
  const admin = adminOf(adminId);
  await setOrganizationSlug(admin, world.orgId, 't20-public-org', db);
  await setProjectVisibility(world.owner, world.projectId, 'public');
  await setProjectVisibility(world.owner, world.otherProjectId, 'public');
  await createProject(world.owner, { name: 'Secret', slug: 'secret', idempotencyKey: newId() });

  const listed = await listPublicThreads({ orgSlug: 't20-public-org', projectSlug: 'board', query: 'zebrapublic' }, db);
  expect(listed.items.map((item) => item.title)).toEqual(['Public thread']);
  expect(listed.project).toEqual({ slug: 'board', name: 'Board', description: 'Visible board' });
  expect(listed.items[0]).toMatchObject({
    author: { displayName: 'Owner', kind: 'human' }, category: 'note', urgent: true, pinned: false, replyCount: 1,
  });
  const hiddenSearch = await listPublicThreads({ orgSlug: 't20-public-org', projectSlug: 'board', query: 'archivedsecretword' }, db);
  expect(hiddenSearch.items).toEqual([]);

  const thread = await getPublicThread({ orgSlug: 't20-public-org', projectSlug: 'board', rootId: world.rootId }, db);
  expect(thread.root.title).toBe('Public thread');
  expect(thread.root.body).toBe('zebrapublic body');
  expect(thread.replies.map((reply) => reply.body)).toEqual(['reply visible text']);
  expect(thread.replies[0]?.author).toEqual({ displayName: 'field-agent', kind: 'agent' });
  const forbiddenKeys = ['recipients', 'authorUserId', 'authorTokenId', 'authorAgentId', 'authorSessionId', 'userId', 'tokenId', 'sessionId', 'tokenPrefix', 'prefix', 'orgId', 'projectId'];
  for (const value of [listed, thread]) {
    const keys = keysOf(value);
    for (const key of forbiddenKeys) expect(keys.has(key), key).toBe(false);
    const raw = JSON.stringify(value);
    expect(raw).not.toContain(world.userId);
    expect(raw).not.toContain(world.tokenId);
    expect(raw).not.toContain(world.sessionId);
    expect(raw).not.toContain(world.prefix);
    expect(raw).not.toContain('recipient-only');
  }

  const foreign = await seedOrg('t20-foreign');
  await setOrganizationSlug(admin, foreign.orgId, 't20-foreign-org', db);
  await setProjectVisibility(foreign.owner, foreign.projectId, 'public');
  expect((await getPublicThread({ orgSlug: 't20-public-org', projectSlug: 'other', rootId: world.otherRootId }, db)).root.title).toBe('Other project thread');
  await db.update(organizations).set({ status: 'suspended' }).where(eq(organizations.id, foreign.orgId));

  const cases = [
    () => listPublicThreads({ orgSlug: 't20-public-org', projectSlug: 'missing' }, db),
    () => listPublicThreads({ orgSlug: 't20-public-org', projectSlug: 'secret' }, db),
    () => listPublicThreads({ orgSlug: 'missing-org-slug', projectSlug: 'board' }, db),
    () => listPublicThreads({ orgSlug: 't20-foreign-org', projectSlug: 'board' }, db),
    () => getPublicThread({ orgSlug: 't20-public-org', projectSlug: 'board', rootId: world.archivedId }, db),
    () => getPublicThread({ orgSlug: 't20-public-org', projectSlug: 'board', rootId: world.otherRootId }, db),
    () => getPublicThread({ orgSlug: 't20-public-org', projectSlug: 'board', rootId: foreign.rootId }, db),
    () => listPublicThreads({ orgSlug: 'NOPE', projectSlug: 'board' }, db),
  ];
  const errors = [];
  for (const run of cases) errors.push(await catchDomain(run));
  for (const error of errors) {
    expect(error.code).toBe('forbidden_or_not_found');
    expect(error.details).toEqual(errors[0]!.details);
  }
});

test('visibility change is audited, emits access.changed, and agents cannot change visibility or the org slug', async () => {
  const world = await seedOrg('t20-audit');
  const created = await createProject(world.owner, { name: 'Fresh', slug: 'fresh', idempotencyKey: newId() });
  expect(created.visibility).toBe('private');
  expect((await listProjects(world.owner)).find((project) => project.id === created.id)?.visibility).toBe('private');
  await expect(Promise.resolve().then(() => setProjectVisibility(world.agent, created.id, 'public'))).rejects.toMatchObject({ code: 'capability_denied' });
  expect((await listProjects(world.owner)).find((project) => project.id === created.id)?.visibility).toBe('private');
  const updated = await setProjectVisibility(world.owner, created.id, 'public');
  expect(updated.visibility).toBe('public');
  const audits = await withOrgTx(world.owner, (tx) => tx.select().from(auditRecords).where(eq(auditRecords.entityId, created.id)), db);
  expect(audits.find((row) => row.action === 'project.set_visibility')).toMatchObject({
    before: { visibility: 'private' }, after: { visibility: 'public' }, actorKind: 'human', userId: world.userId,
  });
  const kinds = await withOrgTx(world.owner, (tx) => tx.select().from(events).where(eq(events.projectId, created.id)).orderBy(events.seq), db);
  expect(kinds.map((row) => row.kind)).toContain('access.changed');
  const adminId = newId();
  await db.insert(user).values({ id: adminId, name: 'Admin', email: `${adminId}@example.com`, emailVerified: true });
  await db.insert(siteAdmins).values({ userId: adminId });
  await expect(Promise.resolve().then(() => setOrganizationSlug(world.agent, world.orgId, 't20-agent-slug', db))).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  await expect(Promise.resolve().then(() => setOrganizationSlug(world.owner, world.orgId, 't20-owner-slug', db))).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  const saved = await setOrganizationSlug(adminOf(adminId), world.orgId, 't20-owner-slug', db);
  expect(saved.slug).toBe('t20-owner-slug');
  const slugAudit = await withOrgBootstrapTx(world.orgId, (tx) => tx.select().from(auditRecords).where(eq(auditRecords.action, 'organization.set_slug')), db);
  expect(slugAudit.at(-1)).toMatchObject({ before: { slug: null }, after: { slug: 't20-owner-slug' }, orgId: world.orgId, userId: adminId });
});

test('reserved, malformed, and duplicate organization slugs are rejected', async () => {
  const world = await seedOrg('t20-slug');
  const other = await seedOrg('t20-slug-other');
  const adminId = newId();
  await db.insert(user).values({ id: adminId, name: 'Admin', email: `${adminId}@example.com`, emailVerified: true });
  await db.insert(siteAdmins).values({ userId: adminId });
  const admin = adminOf(adminId);
  for (const slug of ['projects', 'sign-in', 'admin', 'api', '_next', 'favicon.ico', 'A', 'a', 'ab_c', '-lead', 'a'.repeat(41)]) {
    await expect(setOrganizationSlug(admin, world.orgId, slug, db)).rejects.toMatchObject({ code: 'validation_failed', details: { field: 'slug' } });
  }
  await setOrganizationSlug(admin, world.orgId, 'shared-slug', db);
  await expect(setOrganizationSlug(admin, other.orgId, 'shared-slug', db)).rejects.toMatchObject({
    code: 'validation_failed', details: { field: 'slug' },
  });
  const [row] = await db.select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, other.orgId));
  expect(row?.slug).toBeNull();
});

test('public thread pages paginate active roots by activity', async () => {
  const world = await seedOrg('t20-page');
  const adminId = newId();
  await db.insert(user).values({ id: adminId, name: 'Admin', email: `${adminId}@example.com`, emailVerified: true });
  await db.insert(siteAdmins).values({ userId: adminId });
  await setOrganizationSlug(adminOf(adminId), world.orgId, 't20-page-org', db);
  await setProjectVisibility(world.owner, world.projectId, 'public');
  const ids = [newId(), newId(), newId()];
  await withOrgBootstrapTx(world.orgId, async (tx) => {
    for (const [index, id] of ids.entries()) {
      await tx.insert(messages).values({
        id, orgId: world.orgId, projectId: world.projectId, title: `Page ${index}`, body: `page body ${index}`,
        category: 'note', status: 'active', urgent: false, pinned: false, version: 1,
        lastActivityAt: new Date(Date.UTC(2026, 10, index + 1)),
        authorKind: 'human', authorUserId: world.userId, authorDisplayName: 'Owner',
      });
    }
  }, db);
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const result = await listPublicThreads({ orgSlug: 't20-page-org', projectSlug: 'board', limit: 1, ...(cursor ? { cursor } : {}) }, db);
    if (result.items[0]) seen.push(result.items[0].title);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  expect(seen).toContain('Page 0');
  expect(seen).toContain('Page 1');
  expect(seen).toContain('Page 2');
  expect(seen).toContain('Public thread');
  expect(new Set(seen).size).toBe(seen.length);
});

function sqlStatements(source: string): string[] {
  return source.split('--> statement-breakpoint').map((part) => part.trim()).filter((part) => part.length > 0);
}

test('migration 0002 on populated organizations and projects sets private visibility and null slugs', async () => {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error('TEST_DATABASE_URL is required');
  const name = `amb_t20mig_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  try {
    await client.connect();
    const earlier = readdirSync('drizzle').filter((file) => /^\d{4}_.*\.sql$/.test(file) && !file.startsWith('0002')).sort();
    expect(earlier.map((file) => file.slice(0, 4))).toEqual(['0000', '0001']);
    for (const file of earlier) {
      for (const statement of sqlStatements(readFileSync(`drizzle/${file}`, 'utf8'))) await client.query(statement);
    }
    const userId = newId();
    const orgId = newId();
    const projectId = newId();
    await client.query('insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, $2, $3, true, now(), now())', [userId, 'Legacy', `${userId}@example.com`]);
    await client.query('insert into organizations (id, name, status) values ($1, $2, $3)', [orgId, 'Legacy org', 'active']);
    await client.query(`insert into projects (id, org_id, slug, name, status, created_by_kind, created_by_user_id)
      values ($1, $2, 'legacy', 'Legacy', 'active', 'human', $3)`, [projectId, orgId, userId]);
    const migration = readdirSync('drizzle').filter((file) => file.startsWith('0002_') && file.endsWith('.sql'));
    expect(migration).toHaveLength(1);
    for (const statement of sqlStatements(readFileSync(`drizzle/${migration[0]}`, 'utf8'))) await client.query(statement);
    const orgs = await client.query<{ slug: string | null }>('select slug from organizations');
    const rows = await client.query<{ visibility: string }>('select visibility from projects');
    expect(orgs.rows).toEqual([{ slug: null }]);
    expect(rows.rows).toEqual([{ visibility: 'private' }]);
  } finally {
    await client.end();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const activity = await admin.query<{ n: number }>('select count(*)::int as n from pg_stat_activity where datname = $1', [name]);
      if (activity.rows[0]?.n === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  }
});
