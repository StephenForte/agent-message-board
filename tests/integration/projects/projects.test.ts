import { eq, sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import * as schema from '../../../src/db/schema';
import * as c from '../../../src/domain/credentials';
import * as p from '../../../src/domain/projects';
import { newId, withOrgTx } from '../../../src/domain/kernel';
import { admin, fixture } from '../credentials/fixtures';

const auth = (secret: string) => c.authenticateBearer(`Bearer ${secret}`, { requestId: 'projects-test', interface: 'mcp' });
async function creatingAgent(canCreateProjects = true) {
  const f = await fixture();
  const issued = await c.createToken(f.owner, { label: 'creator', scope: 'projects', canCreateProjects });
  const principal = await auth(issued.secret);
  const connected = await c.connectAgent(principal, { name: 'creator' });
  const resolved = await c.resolveAgentSession(principal, connected.sessionId);
  return { ...f, issued, principal, resolved };
}

test('restricted creation grants exactly the new project to this token, defaults the agent and audits atomically', async () => {
  const f = await creatingAgent();
  const other = await c.createToken(f.owner, { label: 'other', scope: 'projects' });
  const broad = await c.createToken(f.owner, { label: 'broad', scope: 'org' });
  const row = await p.createProject(f.resolved, { name: 'New', slug: 'new', idempotencyKey: 'create' });
  const grants = await admin.db.select().from(schema.tokenProjectGrants).where(eq(schema.tokenProjectGrants.projectId, row.id));
  expect(grants).toMatchObject([{ tokenId: f.issued.token.id, source: 'agent_create' }]);
  const defaults = await admin.db.select().from(schema.agentProjectDefaults).where(eq(schema.agentProjectDefaults.projectId, row.id));
  expect(defaults).toMatchObject([{ agentId: f.resolved.agentId }]);
  const events = await admin.db.select().from(schema.events).where(eq(schema.events.projectId, row.id));
  expect(events).toMatchObject([{ kind: 'project.created' }]);
  const audit = await admin.db.select().from(schema.auditRecords).where(eq(schema.auditRecords.entityId, row.id));
  expect(audit).toMatchObject([{ action: 'project.create', tokenId: f.issued.token.id, agentId: f.resolved.agentId, sessionId: f.resolved.sessionId }]);
  expect((await p.listProjects(await auth(f.issued.secret))).map((p) => p.id)).toContain(row.id);
  expect(await p.listProjects(await auth(other.secret))).toEqual([]);
  expect((await p.listProjects(await auth(broad.secret))).map((p) => p.id)).toContain(row.id);
  await expect(p.getProjectBySlug(await auth(other.secret), row.slug)).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
});

test('failure after grant insertion rolls back project, grant, default, event, audit and idempotency', async () => {
  const f = await creatingAgent();
  // Test-only trigger fails precisely after the grant and before the default is stored.
  await admin.pool.query(`create function t04_fail_default() returns trigger language plpgsql as $$
    begin if exists(select 1 from projects where id = NEW.project_id and slug = 'rollback') then raise exception 'injected after grant'; end if; return NEW; end $$`);
  await admin.pool.query('create trigger t04_failure before insert on agent_project_defaults for each row execute function t04_fail_default()');
  const before = await admin.db.select().from(schema.auditRecords).where(eq(schema.auditRecords.orgId, f.orgId));
  const input = { name: 'Rollback', slug: 'rollback', idempotencyKey: 'rollback' };
  try {
    await expect(p.createProject(f.resolved, input)).rejects.toThrow();
    expect(await admin.db.select().from(schema.projects).where(eq(schema.projects.slug, 'rollback'))).toEqual([]);
    expect(await admin.db.select().from(schema.tokenProjectGrants).where(eq(schema.tokenProjectGrants.tokenId, f.issued.token.id))).toEqual([]);
    expect(await admin.db.select().from(schema.agentProjectDefaults).where(eq(schema.agentProjectDefaults.agentId, f.resolved.agentId!))).toEqual([]);
    expect(await admin.db.select().from(schema.auditRecords).where(eq(schema.auditRecords.orgId, f.orgId))).toHaveLength(before.length);
    const events = await admin.db.select().from(schema.events).where(eq(schema.events.orgId, f.orgId));
    expect(events.some((event) => event.kind === 'project.created')).toBe(false);
    expect(await admin.db.select().from(schema.idempotencyRecords).where(eq(schema.idempotencyRecords.orgId, f.orgId))).toEqual([]);
  } finally {
    await admin.pool.query('drop trigger t04_failure on agent_project_defaults');
    await admin.pool.query('drop function t04_fail_default()');
  }
  expect((await p.createProject(f.resolved, input)).slug).toBe('rollback');
});

test('concurrent create with one idempotency key commits once; different payload conflicts', async () => {
  const f = await creatingAgent();
  const input = { name: 'Concurrent', slug: 'concurrent', idempotencyKey: 'same' };
  const [a, b] = await Promise.all([p.createProject(f.resolved, input), p.createProject(f.resolved, input)]);
  expect(a).toEqual(b);
  expect(await admin.db.select().from(schema.projects).where(eq(schema.projects.id, a.id))).toHaveLength(1);
  await expect(p.createProject(f.resolved, { ...input, name: 'Different' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  await expect(p.createProject(f.resolved, { ...input, idempotencyKey: 'new-key' })).rejects.toMatchObject({ code: 'validation_failed', details: { field: 'slug' } });
});

test('org token creation adds default without grant; creation capability and session are mandatory', async () => {
  const f = await creatingAgent(false);
  await expect(p.createProject(f.resolved, { name: 'No', slug: 'no', idempotencyKey: 'no' })).rejects.toMatchObject({ code: 'capability_denied' });
  const issued = await c.createToken(f.owner, { label: 'org', scope: 'org' });
  const principal = await auth(issued.secret);
  await expect(p.createProject(principal, { name: 'No', slug: 'no', idempotencyKey: 'no' })).rejects.toMatchObject({ code: 'unauthenticated' });
  const connected = await c.connectAgent(principal, { name: 'org-agent' });
  const resolved = await c.resolveAgentSession(principal, connected.sessionId);
  const row = await p.createProject(resolved, { name: 'Org', slug: 'org', idempotencyKey: 'org' });
  expect(await admin.db.select().from(schema.tokenProjectGrants).where(eq(schema.tokenProjectGrants.projectId, row.id))).toEqual([]);
  expect((await c.connectAgent(principal, { name: 'org-agent' })).defaults).toMatchObject([{ id: row.id }]);
});

test('owner updates and archive/restore preserve provenance, event order, and audit before/after', async () => {
  const f = await fixture();
  const row = await p.createProject(f.owner, { name: 'Life', slug: 'life', idempotencyKey: newId() });
  await p.updateProject(f.owner, row.id, { name: 'Renamed', description: 'Details', status: 'archived' } as { name: string; description: string });
  expect((await p.getProjectBySlug(f.owner, 'life')).status).toBe('active');
  await p.archiveProject(f.owner, row.id);
  expect((await p.listProjects(f.owner)).some((p) => p.id === row.id)).toBe(false);
  expect((await p.listProjects(f.owner, { includeArchived: true })).some((p) => p.id === row.id)).toBe(true);
  await p.restoreProject(f.owner, row.id);
  const events = await admin.db.select().from(schema.events).where(eq(schema.events.projectId, row.id)).orderBy(schema.events.seq);
  expect(events.map((e) => e.kind)).toEqual(['project.created', 'project.updated', 'project.archived', 'project.restored']);
  const audits = await admin.db.select().from(schema.auditRecords).where(eq(schema.auditRecords.entityId, row.id));
  expect(audits.find((a) => a.action === 'project.archived')).toMatchObject({ before: { status: 'active' }, after: { status: 'archived' } });
  expect(audits.find((a) => a.action === 'project.restored')).toMatchObject({ before: { status: 'archived' }, after: { status: 'active' } });
  expect(await withOrgTx(f.owner, (tx, ctx) => p.getProjectBySlugInTx(tx, ctx, 'life'))).toMatchObject({ name: 'Renamed' });
  expect(await withOrgTx(f.owner, p.listProjectsInTx)).toHaveLength(2);
});

test('cross-org reads and mutations fail without disclosing projects; invalid UUIDs get domain errors', async () => {
  const f = await fixture(); const other = await fixture();
  const foreign = await p.createProject(other.owner, { name: 'Foreign', slug: 'foreign', idempotencyKey: newId() });
  for (const call of [() => p.getProjectBySlug(f.owner, foreign.slug), () => p.updateProject(f.owner, foreign.id, { name: 'Bad' }),
    () => p.archiveProject(f.owner, foreign.id), () => p.restoreProject(f.owner, foreign.id), () => p.archiveProject(f.owner, 'invalid')]) {
    await expect(Promise.resolve().then<unknown>(() => call())).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  }
  const runtimeRows = await withOrgTx(f.owner, (tx) => tx.execute(sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`));
  expect(runtimeRows.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
});
