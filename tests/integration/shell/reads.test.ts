import { afterAll, beforeAll, expect, test } from 'vitest';
import * as schema from '../../../src/db/schema/index';
import { setOrgAnnouncement, setSiteAnnouncement } from '../../../src/domain/announcements';
import { listAuditLog } from '../../../src/domain/auditlog';
import { newId, type AgentPrincipal, type HumanPrincipal } from '../../../src/domain/kernel';
import { getOrgHome, getOwnerProfile } from '../../../src/domain/orghome';
import { tokenPrefix, sha256Hex, type TestDatabase } from '../helpers';
import { countClientQueries, createShellDatabase } from './fixture';

let cleanup: (() => Promise<void>) | undefined;
let admin: TestDatabase;
let runtime: TestDatabase;
let queries: { count: number };

const wide = {
  userId: newId(), name: 'Wide Owner', orgId: newId(), projectId: '', agentId: newId(),
};
const small = { userId: newId(), name: 'Small Owner', orgId: newId(), projectId: newId() };
const auditOrg = {
  userId: newId(), name: 'Audit Owner', orgId: newId(), tokenId: newId(), agentId: newId(), prefix: tokenPrefix(),
};
const adminUser = { userId: newId(), name: 'Site Admin' };

beforeAll(async () => {
  process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
  const database = await createShellDatabase();
  cleanup = database.cleanup;
  admin = database.admin.db;
  runtime = database.runtime.db;
  queries = countClientQueries(database.runtime.pool);
  await admin.insert(schema.user).values([
    { id: wide.userId, name: wide.name, email: `${wide.userId}@example.com`, emailVerified: true },
    { id: small.userId, name: small.name, email: `${small.userId}@example.com`, emailVerified: true },
    { id: auditOrg.userId, name: auditOrg.name, email: `${auditOrg.userId}@example.com`, emailVerified: true },
    { id: adminUser.userId, name: adminUser.name, email: `${adminUser.userId}@example.com`, emailVerified: true },
  ]);
  await admin.insert(schema.siteAdmins).values({ userId: adminUser.userId });
  await admin.insert(schema.organizations).values([
    { id: wide.orgId, name: 'Wide', ownerUserId: wide.userId, status: 'active' },
    { id: small.orgId, name: 'Small', ownerUserId: small.userId, status: 'active' },
    { id: auditOrg.orgId, name: 'Audit', ownerUserId: auditOrg.userId, status: 'active' },
  ]);
  const projects = Array.from({ length: 100 }, (_, index) => {
    const id = newId();
    if (index === 0) wide.projectId = id;
    return {
      id, orgId: wide.orgId, slug: `p${String(index).padStart(3, '0')}`, name: `Project ${index}`,
      status: 'active' as const, createdByKind: 'human' as const, createdByUserId: wide.userId,
    };
  });
  await admin.insert(schema.projects).values([
    ...projects,
    {
      id: newId(), orgId: wide.orgId, slug: 'archived-secret', name: 'Archived Secret Project',
      status: 'archived', createdByKind: 'human', createdByUserId: wide.userId,
    },
    {
      id: small.projectId, orgId: small.orgId, slug: 'foreign', name: 'Foreign Org Project',
      status: 'active', createdByKind: 'human', createdByUserId: small.userId,
    },
  ]);
  const active = new Date('2026-11-02T00:00:00.000Z');
  const earlier = new Date('2026-11-01T00:00:00.000Z');
  const archivedAt = new Date('2026-11-03T00:00:00.000Z');
  const activeRoot = newId();
  await admin.insert(schema.messages).values([
    root(wide, wide.projectId, activeRoot, 'Active note', false, 'active', earlier),
    root(wide, wide.projectId, newId(), 'Urgent note', true, 'active', active),
    root(wide, wide.projectId, newId(), 'Archived urgent', true, 'archived', archivedAt),
    {
      id: newId(), orgId: wide.orgId, projectId: wide.projectId, rootId: activeRoot, body: 'reply does not count',
      authorKind: 'human', authorUserId: wide.userId, authorDisplayName: wide.name,
    },
    ...Array.from({ length: 5 }, () => root(small, small.projectId, newId(), 'Foreign urgent', true, 'active', active)),
  ]);
  await admin.insert(schema.agents).values([
    { id: wide.agentId, orgId: wide.orgId, name: 'alpha-agent', lastSeenAt: new Date('2026-11-08T12:00:00.000Z') },
    { id: newId(), orgId: small.orgId, name: 'foreign-agent', lastSeenAt: new Date('2026-11-08T12:00:00.000Z') },
  ]);
  await setSiteAnnouncement(human(adminUser.userId, null, true), {
    title: 'Site notice', body: 'Visible to every organization', expectedVersion: 0,
  }, runtime);
  await setOrgAnnouncement(human(wide.userId, wide.orgId), {
    title: 'Wide notice', body: 'Only the wide organization', expectedVersion: 0,
  }, runtime);
  await setOrgAnnouncement(human(small.userId, small.orgId), {
    title: 'Small notice', body: 'Only the small organization', expectedVersion: 0,
  }, runtime);
  await seedAuditRows();
});

afterAll(async () => {
  await cleanup?.();
});

test('org home counts are exact, org-scoped, and bounded at 100 projects', async () => {
  await getOrgHome(human(small.userId, small.orgId), runtime);
  const smallQueries = await measured(human(small.userId, small.orgId));
  const wideHome = await measuredHome(human(wide.userId, wide.orgId));
  expect(wideHome.projects).toHaveLength(100);
  expect(wideHome.projects.some((project) => project.name === 'Archived Secret Project')).toBe(false);
  expect(wideHome.projects.some((project) => project.name === 'Foreign Org Project')).toBe(false);
  const counted = wideHome.projects.find((project) => project.slug === 'p000');
  expect(counted).toMatchObject({ activeRootCount: 2, urgentRootCount: 1, lastActivityAt: '2026-11-02T00:00:00.000Z' });
  expect(wideHome.projects.filter((project) => project.slug !== 'p000').every((project) => project.activeRootCount === 0)).toBe(true);
  expect(wideHome.agents.map((agent) => agent.name)).toEqual(['alpha-agent']);
  expect(wideHome.agents[0]?.lastSeenAt).toBe('2026-11-08T12:00:00.000Z');
  expect(wideHome.announcements.site?.title).toBe('Site notice');
  expect(wideHome.announcements.org?.body).toBe('Only the wide organization');
  const smallHome = await getOrgHome(human(small.userId, small.orgId), runtime);
  expect(smallHome.projects.map((project) => project.name)).toEqual(['Foreign Org Project']);
  expect(smallHome.projects[0]).toMatchObject({ activeRootCount: 5, urgentRootCount: 5 });
  expect(smallHome.announcements.org?.body).toBe('Only the small organization');
  expect(smallHome.announcements.site?.title).toBe('Site notice');
  expect(smallHome.agents.map((agent) => agent.name)).toEqual(['foreign-agent']);
  expect(wideHome.queries).toBeLessThan(30);
  expect(wideHome.queries).toBeLessThan(wideHome.projects.length);
  expect(Math.abs(wideHome.queries - smallQueries)).toBeLessThanOrEqual(2);
  expect((await getOwnerProfile(human(wide.userId, wide.orgId), runtime)).name).toBe('Wide Owner');
  await expect(getOrgHome(agentPrincipal(wide.orgId), runtime)).rejects.toMatchObject({ code: 'capability_denied' });
});

test('audit log is owner-only, paginated, and hides session activity by default', async () => {
  const owner = human(auditOrg.userId, auditOrg.orgId);
  await expect(listAuditLog(agentPrincipal(auditOrg.orgId), {}, runtime)).rejects.toMatchObject({ code: 'capability_denied' });
  const first = await listAuditLog(owner, { limit: 2 }, runtime);
  const second = await listAuditLog(owner, { limit: 2, cursor: first.nextCursor ?? undefined }, runtime);
  const third = await listAuditLog(owner, { limit: 2, cursor: second.nextCursor ?? undefined }, runtime);
  const hidden = [...first.items, ...second.items, ...third.items];
  expect(first.items).toHaveLength(2);
  expect(second.items).toHaveLength(2);
  expect(third.items).toHaveLength(1);
  expect(third.nextCursor).toBeNull();
  expect(hidden.map((entry) => entry.action)).toEqual(['human.5', 'human.4', 'human.3', 'human.2', 'human.1']);
  expect(hidden.some((entry) => entry.action === 'agent.session_seen')).toBe(false);
  expect(hidden.some((entry) => entry.action === 'foreign.marker')).toBe(false);
  expect(first.items[0]?.actorLabel).toBe(`Human, ${auditOrg.name}`);
  const withSessions = await listAuditLog(owner, { includeSessionSeen: true, limit: 10 }, runtime);
  expect(withSessions.items.map((entry) => entry.action)).toEqual([
    'agent.session_seen', 'human.5', 'human.4', 'human.3', 'human.2', 'human.1',
  ]);
  const session = withSessions.items[0];
  expect(session?.actorLabel).toBe(`Agent logger, token ${auditOrg.prefix}`);
  expect(session?.summary).toContain('seen');
  await expect(listAuditLog(owner, { cursor: first.nextCursor ?? undefined, includeSessionSeen: true }, runtime)).rejects.toMatchObject({ code: 'invalid_cursor' });
  await expect(listAuditLog(owner, { limit: 0 }, runtime)).rejects.toMatchObject({ code: 'validation_failed' });
  const foreign = await listAuditLog(human(small.userId, small.orgId), { includeSessionSeen: true, limit: 100 }, runtime);
  const foreignActions = foreign.items.map((entry) => entry.action);
  expect(foreignActions).toContain('foreign.marker');
  expect(foreignActions).not.toContain('human.1');
  expect(foreignActions).not.toContain('agent.session_seen');
});

async function measured(principal: HumanPrincipal): Promise<number> {
  const start = queries.count;
  await getOrgHome(principal, runtime);
  return queries.count - start;
}

async function measuredHome(principal: HumanPrincipal) {
  const start = queries.count;
  const home = await getOrgHome(principal, runtime);
  return { ...home, queries: queries.count - start };
}

function human(userId: string, orgId: string | null, siteAdmin = false): HumanPrincipal {
  return { kind: 'human', userId, orgId, siteAdmin, interface: 'web', requestId: 't08-integration' };
}

function agentPrincipal(orgId: string): AgentPrincipal {
  return {
    kind: 'agent', orgId, tokenId: newId(), scope: 'org', projectIds: 'all', canCreateProjects: false,
    agentId: null, sessionId: null, interface: 'mcp', requestId: 't08-agent',
  };
}

function root(owner: { orgId: string; userId: string; name: string }, projectId: string, id: string, title: string, urgent: boolean, status: 'active' | 'archived', lastActivityAt: Date) {
  return {
    id, orgId: owner.orgId, projectId, title, body: title, category: 'note', status, urgent, pinned: false, version: 1,
    lastActivityAt, authorKind: 'human' as const, authorUserId: owner.userId, authorDisplayName: owner.name,
  };
}

async function seedAuditRows() {
  await admin.insert(schema.agentTokens).values({
    id: auditOrg.tokenId, orgId: auditOrg.orgId, label: 'logger', prefix: auditOrg.prefix, tokenHash: sha256Hex(),
    scope: 'org', canCreateProjects: false, createdByUserId: auditOrg.userId,
  });
  await admin.insert(schema.agents).values({ id: auditOrg.agentId, orgId: auditOrg.orgId, name: 'logger' });
  const rows = [
    entry('agent.session_seen', 6, { actorKind: 'agent' as const, after: { seen: true } }),
    ...[5, 4, 3, 2, 1].map((n) => entry(`human.${n}`, n, { actorKind: 'human' as const, after: { n } })),
  ];
  await admin.insert(schema.auditRecords).values(rows);
  await admin.insert(schema.auditRecords).values({
    id: newId(), orgId: small.orgId, actorKind: 'human', userId: small.userId, interfaceKind: 'web',
    requestId: 'foreign', action: 'foreign.marker', entityType: 'project', entityId: small.projectId,
    createdAt: new Date('2026-11-09T00:00:06.000Z'),
  });
}

function entry(action: string, second: number, actor: { actorKind: 'human' | 'agent'; after: Record<string, unknown> }) {
  return {
    id: newId(), orgId: auditOrg.orgId, actorKind: actor.actorKind,
    userId: actor.actorKind === 'human' ? auditOrg.userId : null,
    tokenId: actor.actorKind === 'agent' ? auditOrg.tokenId : null,
    agentId: actor.actorKind === 'agent' ? auditOrg.agentId : null,
    interfaceKind: 'web' as const, requestId: 't08-audit', action, entityType: 'note', entityId: newId(),
    after: actor.after, createdAt: new Date(`2026-11-09T00:00:0${second}.000Z`),
  };
}
