import { spawnSync } from 'node:child_process';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { rlsExemptTableNames, tenantTableNames } from '../../src/db/schema/index';
import * as schema from '../../src/db/schema/index';
import { newId } from '../../src/domain/kernel/ids';
import { withOrgTx, withSiteAdminTx, withTokenLookupTx } from '../../src/domain/kernel/tx';
import {
  adminUrl, insertRoot, openDatabase, runtimeUrl, seedOrg, systemPrincipal,
} from './helpers';

const admin = openDatabase(adminUrl());
const runtime = openDatabase(runtimeUrl(), 4);
let seedX: Awaited<ReturnType<typeof seedOrg>>;
let seedY: Awaited<ReturnType<typeof seedOrg>>;
let rootX = '';

beforeAll(async () => {
  seedX = await seedOrg(admin.db, 'orgx');
  seedY = await seedOrg(admin.db, 'orgy');
  rootX = await insertRoot(admin.db, seedX, 'X root');
  await insertRoot(admin.db, seedY, 'Y root');
  await admin.db.insert(schema.events).values({
    orgId: seedY.orgId, seq: 1, kind: 'project.created', projectId: seedY.projectId, payload: { name: 'Y' },
  });
  await admin.db.insert(schema.auditRecords).values({
    id: newId(), orgId: seedY.orgId, actorKind: 'human', userId: seedY.userId,
    interfaceKind: 'web', requestId: 'seed', action: 'seed', entityType: 'project', entityId: seedY.projectId,
  });
  await admin.db.insert(schema.announcements).values({
    id: newId(), scope: 'site', title: 'Site notice', body: 'all orgs', version: 1, authorUserId: seedX.userId,
  });
  await admin.db.insert(schema.announcements).values({
    id: newId(), scope: 'org', orgId: seedY.orgId, title: 'Y only', body: 'org y', version: 1, authorUserId: seedY.userId,
  });
});

afterAll(async () => {
  await admin.pool.end();
  await runtime.pool.end();
});

test('runtime role is not superuser and does not bypass RLS', async () => {
  const client = new pg.Client({ connectionString: runtimeUrl() });
  await client.connect();
  try {
    const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }>(
      'select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user',
    );
    expect(role.rows[0]?.rolsuper).toBe(false);
    expect(role.rows[0]?.rolbypassrls).toBe(false);
    const owner = await client.query<{ tableowner: string }>(
      "select tableowner from pg_tables where schemaname = 'public' and tablename = 'messages'",
    );
    expect(owner.rows[0]?.tableowner).not.toBe(role.rows[0]?.rolname);
  } finally {
    await client.end();
  }
});

test('property 2: RLS hides other orgs and fails closed with no org setting', async () => {
  const client = new pg.Client({ connectionString: runtimeUrl() });
  await client.connect();
  try {
    await client.query('begin');
    for (const table of tenantTableNames) {
      const rows = await client.query<{ n: number }>(`select count(*)::int as n from "${table}"`);
      expect(rows.rows[0]?.n, table).toBe(0);
    }
    await client.query('rollback');

    await client.query('begin');
    await client.query(`select set_config('app.org_id', $1, true)`, [seedX.orgId]);
    for (const table of tenantTableNames) {
      const rows = await client.query<{ n: number }>(
        `select count(*)::int as n from "${table}" where org_id = $1`,
        [seedY.orgId],
      );
      expect(rows.rows[0]?.n, table).toBe(0);
    }
    const site = await client.query<{ n: number }>(
      `select count(*)::int as n from announcements where scope = 'site'`,
    );
    const own = await client.query<{ n: number }>(
      `select count(*)::int as n from messages where org_id = $1`,
      [seedX.orgId],
    );
    expect(site.rows[0]?.n).toBe(1);
    expect(own.rows[0]?.n).toBe(1);
    await client.query('rollback');
  } finally {
    await client.end();
  }

  await expect(withOrgTx(systemPrincipal(seedX.orgId), async (tx) => {
    await tx.insert(schema.agents).values({ id: newId(), orgId: seedY.orgId, name: 'intruder' });
  }, runtime.db)).rejects.toThrow();
});

test('property 3: the superuser sees the rows RLS hid', async () => {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
    );
    expect(role.rows[0]?.rolsuper || role.rows[0]?.rolbypassrls).toBe(true);
    const messages = await client.query<{ n: number }>(
      'select count(*)::int as n from messages where org_id = $1',
      [seedY.orgId],
    );
    const events = await client.query<{ n: number }>('select count(*)::int as n from events where org_id = $1', [seedY.orgId]);
    const audits = await client.query<{ n: number }>('select count(*)::int as n from audit_records where org_id = $1', [seedY.orgId]);
    const tokens = await client.query<{ n: number }>('select count(*)::int as n from agent_tokens where org_id = $1', [seedY.orgId]);
    expect(messages.rows[0]?.n).toBeGreaterThan(0);
    expect(events.rows[0]?.n).toBeGreaterThan(0);
    expect(audits.rows[0]?.n).toBeGreaterThan(0);
    expect(tokens.rows[0]?.n).toBeGreaterThan(0);
  } finally {
    await client.end();
  }
});

test('property 4: composite foreign keys reject cross-org and cross-project links', async () => {
  const otherProject = newId();
  await admin.db.insert(schema.projects).values({
    id: otherProject, orgId: seedX.orgId, slug: 'beta', name: 'Beta', status: 'active',
    createdByKind: 'human', createdByUserId: seedX.userId,
  });
  const rootY = await insertRoot(admin.db, seedY, 'Y for fk');
  await expectConstraint(admin.db.insert(schema.messages).values(reply(seedX, rootY, seedX.projectId)));
  await expectConstraint(admin.db.insert(schema.messages).values(reply(seedX, rootX, otherProject)));
  await expectConstraint(admin.db.insert(schema.messageRecipients).values({
    orgId: seedX.orgId, messageId: rootX, agentId: seedY.agentId,
  }));
  await expectConstraint(admin.db.insert(schema.tokenProjectGrants).values({
    orgId: seedX.orgId, tokenId: seedX.tokenId, projectId: seedY.projectId, source: 'owner',
  }));

  const replyId = newId();
  await admin.db.insert(schema.messages).values({ ...reply(seedX, rootX, seedX.projectId), id: replyId });
  await expectConstraint(admin.db.insert(schema.messages).values(reply(seedX, replyId, seedX.projectId)), '23514');
});

test('property 8: prefix lookup returns one token and cannot list the others', async () => {
  const found = await withTokenLookupTx(seedX.prefix, async (tx, token) => {
    const visible = await tx.select({ prefix: schema.agentTokens.prefix }).from(schema.agentTokens);
    return { token, visible };
  }, runtime.db);
  expect(found.token?.id).toBe(seedX.tokenId);
  expect(found.token?.tokenHash).toBe(seedX.tokenHash);
  expect(found.visible.map((row) => row.prefix)).toEqual([seedX.prefix]);
  expect(found.token && 'label' in found.token).toBe(false);

  const missing = await withTokenLookupTx('zzzzzzzz', async (tx, token) => {
    const visible = await tx.select({ id: schema.agentTokens.id }).from(schema.agentTokens);
    return { token, visible };
  }, runtime.db);
  expect(missing.token).toBeNull();
  expect(missing.visible).toEqual([]);

  const scoped = await withOrgTx(systemPrincipal(seedX.orgId), async (tx) => {
    await tx.execute(sql`select set_config('app.token_prefix', ${seedY.prefix}, true)`);
    return tx.select({ id: schema.agentTokens.id }).from(schema.agentTokens);
  }, runtime.db);
  expect(scoped.map((row) => row.id)).toEqual([seedX.tokenId]);

  const writes = await withTokenLookupTx(seedX.prefix, async (tx) => {
    const removed = await tx.delete(schema.agentTokens)
      .where(eq(schema.agentTokens.id, seedX.tokenId))
      .returning({ id: schema.agentTokens.id });
    const touched = await tx.update(schema.agentTokens)
      .set({ revokedAt: new Date() })
      .where(eq(schema.agentTokens.id, seedX.tokenId))
      .returning({ id: schema.agentTokens.id });
    return { removed, touched };
  }, runtime.db);
  expect(writes.removed).toEqual([]);
  expect(writes.touched).toEqual([]);
  const still = await admin.db.select({ revokedAt: schema.agentTokens.revokedAt })
    .from(schema.agentTokens)
    .where(eq(schema.agentTokens.id, seedX.tokenId));
  expect(still[0]?.revokedAt).toBeNull();
});

test('site announcements are readable by a tenant and writable only as site admin', async () => {
  const revisionId = newId();
  await admin.db.insert(schema.announcementRevisions).values({
    id: revisionId, scope: 'site', title: 'Site history', body: 'history', version: 1, authorUserId: seedX.userId,
  });

  const tenant = await withOrgTx(systemPrincipal(seedX.orgId), async (tx) => {
    const removed = await tx.delete(schema.announcements)
      .where(eq(schema.announcements.scope, 'site'))
      .returning({ id: schema.announcements.id });
    const hijacked = await tx.update(schema.announcements)
      .set({ scope: 'org', orgId: seedX.orgId, title: 'stolen' })
      .where(eq(schema.announcements.scope, 'site'))
      .returning({ id: schema.announcements.id });
    const history = await tx.delete(schema.announcementRevisions)
      .where(eq(schema.announcementRevisions.id, revisionId))
      .returning({ id: schema.announcementRevisions.id });
    return { removed, hijacked, history };
  }, runtime.db);
  expect(tenant.removed).toEqual([]);
  expect(tenant.hijacked).toEqual([]);
  expect(tenant.history).toEqual([]);

  const site = await admin.db.select({
    scope: schema.announcements.scope, orgId: schema.announcements.orgId, title: schema.announcements.title,
  }).from(schema.announcements).where(eq(schema.announcements.scope, 'site'));
  expect(site).toEqual([{ scope: 'site', orgId: null, title: 'Site notice' }]);

  const written = await withSiteAdminTx(async (tx) => {
    const updated = await tx.update(schema.announcements)
      .set({ title: 'Site notice' })
      .where(eq(schema.announcements.scope, 'site'))
      .returning({ id: schema.announcements.id });
    const removed = await tx.delete(schema.announcementRevisions)
      .where(eq(schema.announcementRevisions.id, revisionId))
      .returning({ id: schema.announcementRevisions.id });
    return { updated, removed };
  }, runtime.db);
  expect(written.updated).toHaveLength(1);
  expect(written.removed).toEqual([{ id: revisionId }]);
});

test('property 10: migration enables forced RLS and db:check reports no drift', async () => {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    const rows = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
    `);
    const byName = new Map(rows.rows.map((row) => [row.relname, row]));
    const known = new Set<string>([...tenantTableNames, ...rlsExemptTableNames]);
    expect([...byName.keys()].sort()).toEqual([...known].sort());
    for (const name of tenantTableNames) {
      expect(byName.get(name)?.relrowsecurity, name).toBe(true);
      expect(byName.get(name)?.relforcerowsecurity, name).toBe(true);
    }
    for (const name of rlsExemptTableNames) {
      expect(byName.get(name)?.relrowsecurity, name).toBe(false);
      expect(byName.get(name)?.relforcerowsecurity, name).toBe(false);
    }
  } finally {
    await client.end();
  }
  const check = spawnSync('npx', ['tsx', 'scripts/db-check.ts'], { encoding: 'utf8' });
  expect(check.status, check.stdout + check.stderr).toBe(0);
});

function reply(seed: { orgId: string; userId: string }, rootId: string, projectId: string) {
  return {
    id: newId(),
    orgId: seed.orgId,
    projectId,
    rootId,
    body: 'reply',
    authorKind: 'human' as const,
    authorUserId: seed.userId,
    authorDisplayName: 'Owner',
  };
}

async function expectConstraint(promise: Promise<unknown>, code = '23503') {
  try {
    await promise;
  } catch (error) {
    expect(postgresCode(error)).toBe(code);
    return;
  }
  throw new Error(`expected SQLSTATE ${code}`);
}

function postgresCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  if ('code' in error && typeof error.code === 'string' && /^\d{5}$/.test(error.code)) return error.code;
  if ('cause' in error) return postgresCode(error.cause);
  return undefined;
}
