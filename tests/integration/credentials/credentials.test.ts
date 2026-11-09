import { and, eq, sql } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';
import * as schema from '../../../src/db/schema';
import * as c from '../../../src/domain/credentials';
import { archiveProject, createProject, listProjects } from '../../../src/domain/projects';
import { newId, withOrgTx } from '../../../src/domain/kernel';
import { admin, fixture } from './fixtures';

const auth = (secret: string) => c.authenticateBearer(`Bearer ${secret}`, { requestId: 'auth-test', interface: 'mcp' });
const project = (owner: Parameters<typeof createProject>[0], slug: string) => createProject(owner, { name: slug, slug, idempotencyKey: newId() });
async function connection(scope: 'org' | 'projects' = 'projects') {
  const f = await fixture();
  const issued = await c.createToken(f.owner, { label: 'test', scope, projectIds: scope === 'projects' ? [f.projectId] : undefined });
  const principal = await auth(issued.secret);
  const connected = await c.connectAgent(principal, { name: 'worker' });
  const resolved = await c.resolveAgentSession(principal, connected.sessionId);
  return { ...f, issued, principal, connected, resolved };
}

test('token formats, safe metadata, fresh grants and last-used updates', async () => {
  const f = await fixture();
  const issued = await c.createToken(f.owner, { label: 'restricted', scope: 'projects', projectIds: [f.projectId] });
  expect(/^amb_[A-Za-z0-9]{8}_[A-Za-z0-9]{40}$/.test(issued.secret)).toBe(true);
  expect(issued.token.canCreateProjects).toBe(false);
  const principal = await auth(issued.secret);
  expect(principal).toMatchObject({ orgId: f.orgId, projectIds: [f.projectId], agentId: null, sessionId: null });
  const [row] = await admin.db.select().from(schema.agentTokens).where(eq(schema.agentTokens.id, issued.token.id));
  expect(row!.lastUsedAt).not.toBeNull();
  expect(row!.tokenHash).toHaveLength(64);
  const metadata = await c.listTokens(f.owner);
  expect(JSON.stringify(metadata).includes('tokenHash')).toBe(false);
  await c.setTokenGrants(f.owner, issued.token.id, []);
  expect((await auth(issued.secret)).projectIds).toEqual([]);
});

test('all invalid credential cases return identical unauthenticated errors', async () => {
  const f = await fixture();
  const issued = await c.createToken(f.owner, { label: 'test', scope: 'org' });
  const wrong = issued.secret.slice(0, -1) + (issued.secret.endsWith('a') ? 'b' : 'a');
  const headers = [undefined, '', 'Basic anything', 'Bearer amb_bad', `Bearer ${wrong}`, `Bearer amb_00000000_${'x'.repeat(40)}`, `Bearer ${issued.secret} trailing`];
  for (const header of headers) {
    await expect(c.authenticateBearer(header, { requestId: 'invalid', interface: 'mcp' })).rejects.toMatchObject({ code: 'unauthenticated', message: 'unauthenticated', details: {} });
  }
  await admin.db.update(schema.agentTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.agentTokens.id, issued.token.id));
  await expect(auth(issued.secret)).rejects.toMatchObject({ code: 'unauthenticated', details: {} });
  await admin.db.update(schema.agentTokens).set({ expiresAt: null }).where(eq(schema.agentTokens.id, issued.token.id));
  await c.revokeToken(f.owner, issued.token.id);
  await expect(auth(issued.secret)).rejects.toMatchObject({ code: 'unauthenticated', details: {} });
});

test('generated secret is absent from every persisted table and captured logs', async () => {
  const f = await fixture();
  const captured: unknown[][] = [];
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map((method) => vi.spyOn(console, method as 'log').mockImplementation((...args) => { captured.push(args); }));
  try {
    const issued = await c.createToken(f.owner, { label: 'safe', scope: 'org' });
    await auth(issued.secret);
    const tables = await admin.db.execute(sql`select tablename from pg_tables where schemaname = 'public'`);
    for (const row of tables.rows) {
      const result = await admin.pool.query(`select coalesce(json_agg(t)::text, '') as data from "${String(row.tablename).replaceAll('"', '""')}" t`);
      expect(String(result.rows[0].data).includes(issued.secret)).toBe(false);
    }
    expect(JSON.stringify(captured).includes(issued.secret)).toBe(false);
  } finally { spies.forEach((spy) => spy.mockRestore()); }
});

test('rotation preserves label, scope, flags, expiry and grants while old credential remains live', async () => {
  const f = await fixture();
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  const issued = await c.createToken(f.owner, { label: 'rotate', scope: 'projects', projectIds: [f.projectId], canCreateProjects: true, expiresAt });
  const replacement = await c.replaceToken(f.owner, issued.token.id);
  expect(replacement.token).toMatchObject({ label: 'rotate', scope: 'projects', projectIds: [f.projectId], canCreateProjects: true, expiresAt });
  expect(replacement.secret !== issued.secret).toBe(true);
  expect((await auth(issued.secret)).tokenId).toBe(issued.token.id);
  expect((await auth(replacement.secret)).tokenId).toBe(replacement.token.id);
});

test('simultaneous first connections differing only by case reuse one agent', async () => {
  const f = await fixture();
  const issued = await c.createToken(f.owner, { label: 'test', scope: 'org' });
  const principal = await auth(issued.secret);
  const [a, b] = await Promise.all([c.connectAgent(principal, { name: 'New.Worker' }), c.connectAgent(principal, { name: 'new.worker', clientLabel: 'second' })]);
  expect(a.agent.id).toBe(b.agent.id);
  expect(a.sessionId).not.toBe(b.sessionId);
  const sessions = await c.listAgentSessions(f.owner, a.agent.id);
  expect(sessions).toHaveLength(2);
  expect(sessions.every((s) => s.tokenPrefix === issued.token.prefix)).toBe(true);
  expect((await c.listAgents(f.owner)).some((agent) => agent.id === a.agent.id)).toBe(true);
});

test('foreign token and malformed session handles fail; resolved sessions advance last-seen', async () => {
  const f = await connection();
  const other = await c.createToken(f.owner, { label: 'other', scope: 'org' });
  await expect(c.resolveAgentSession(await auth(other.secret), f.connected.sessionId)).rejects.toMatchObject({ code: 'unauthenticated' });
  await expect(Promise.resolve().then(() => c.resolveAgentSession(f.principal, 'invalid'))).rejects.toMatchObject({ code: 'unauthenticated' });
  const result = await c.resolveAgentSession(f.principal, f.connected.sessionId);
  expect(result.agentId).toBe(f.connected.agent.id);
  const [session] = await admin.db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, result.sessionId!));
  expect(session!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(new Date(f.connected.agent.lastSeenAt!).getTime());
  await c.revokeToken(f.owner, f.issued.token.id);
  await expect(c.resolveAgentSession(f.principal, f.connected.sessionId)).rejects.toMatchObject({ code: 'unauthenticated' });
});

test('removed grants never survive defaults or selections, including an existing session', async () => {
  const f = await connection();
  await c.setAgentDefaults(f.owner, f.resolved.agentId!, [f.projectId]);
  await c.selectSessionProjects(f.resolved, [f.projectId]);
  expect((await c.resolveTargetProjects(f.resolved, { mode: 'write' }))[0]!.id).toBe(f.projectId);
  await c.setTokenGrants(f.owner, f.issued.token.id, []);
  // The kernel rejects an old principal that still claims the removed grant.
  await expect(c.resolveTargetProjects(f.resolved, { mode: 'write' })).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  const fresh = await auth(f.issued.secret);
  const connected = await c.connectAgent(fresh, { name: 'worker' });
  expect(connected.defaults).toEqual([]);
  const resolved = await c.resolveAgentSession(fresh, f.connected.sessionId);
  await expect(c.selectSessionProjects(resolved, [f.projectId])).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  await expect(c.resolveTargetProjects(resolved, { mode: 'write' })).rejects.toMatchObject({ code: 'no_project_selected' });
  expect(await listProjects(resolved)).toEqual([]);
});

test('target resolution handles zero/one/many defaults, explicit targets, selections and archives', async () => {
  const f = await connection('org');
  await expect(c.resolveTargetProjects(f.resolved, { mode: 'read' })).rejects.toMatchObject({ code: 'no_project_selected' });
  await c.setAgentDefaults(f.owner, f.resolved.agentId!, [f.projectId]);
  expect((await c.resolveTargetProjects(f.resolved, { mode: 'write' }))[0]!.slug).toBe('alpha');
  const second = await project(f.owner, 'second');
  await c.setAgentDefaults(f.owner, f.resolved.agentId!, [f.projectId, second.id]);
  await expect(c.resolveTargetProjects(f.resolved, { mode: 'write' })).rejects.toMatchObject({ code: 'ambiguous_project', details: { projects: expect.arrayContaining([expect.objectContaining({ id: second.id, slug: 'second', name: 'second' })]) } });
  expect(await c.resolveTargetProjects(f.resolved, { mode: 'read' })).toHaveLength(2);
  expect(await withOrgTx(f.resolved, (tx, ctx) => c.resolveTargetProjectsInTx(tx, ctx, { mode: 'read' }))).toHaveLength(2);
  await c.selectSessionProjects(f.resolved, [second.id]);
  expect((await c.resolveTargetProjects(f.resolved, { mode: 'write' }))[0]!.id).toBe(second.id);
  await c.setAgentDefaults(f.owner, f.resolved.agentId!, [f.projectId]);
  await expect(c.resolveTargetProjects(f.resolved, { mode: 'write' })).rejects.toMatchObject({ code: 'no_project_selected' });
  await c.selectSessionProjects(f.resolved, []);
  expect((await c.resolveTargetProjects(f.resolved, { mode: 'write' }))[0]!.id).toBe(f.projectId);
  await archiveProject(f.owner, f.projectId);
  await expect(c.resolveTargetProjects(f.resolved, { mode: 'write' })).rejects.toMatchObject({ code: 'no_project_selected' });
  await expect(c.resolveTargetProjects(f.resolved, { mode: 'write', projectId: f.projectId })).rejects.toMatchObject({ code: 'project_archived' });
  expect(await c.resolveTargetProjects(f.resolved, { mode: 'read', projectId: f.projectId })).toHaveLength(1);
});

test('agents cannot invoke owner operations and no successful mutation is recorded', async () => {
  const f = await connection();
  const before = await admin.db.select().from(schema.auditRecords).where(eq(schema.auditRecords.orgId, f.orgId));
  const calls = [() => c.createToken(f.resolved, { label: 'bad', scope: 'org' }), () => c.listTokens(f.resolved), () => c.revokeToken(f.resolved, f.tokenId),
    () => c.replaceToken(f.resolved, f.tokenId), () => c.setTokenGrants(f.resolved, f.tokenId, []), () => c.setAgentDefaults(f.resolved, f.agentId, []),
    () => c.listAgents(f.resolved), () => c.listAgentSessions(f.resolved, f.agentId), () => archiveProject(f.resolved, f.projectId)];
  for (const call of calls) await expect(Promise.resolve().then<unknown>(() => call())).rejects.toMatchObject({ code: 'capability_denied' });
  const after = await admin.db.select().from(schema.auditRecords).where(eq(schema.auditRecords.orgId, f.orgId));
  expect(after).toHaveLength(before.length);
});

test('cross-org identifiers do not reveal credentials, agents, defaults or projects', async () => {
  const f = await connection(); const other = await fixture();
  for (const call of [() => c.revokeToken(f.owner, other.tokenId), () => c.replaceToken(f.owner, other.tokenId),
    () => c.setTokenGrants(f.owner, other.tokenId, []), () => c.setAgentDefaults(f.owner, other.agentId, []),
    () => c.setAgentDefaults(f.owner, f.agentId, [other.projectId]), () => c.setTokenGrants(f.owner, f.issued.token.id, [other.projectId]),
    () => c.listAgentSessions(f.owner, other.agentId), () => c.resolveTargetProjects(f.resolved, { mode: 'read', projectId: other.projectId })]) {
    await expect(Promise.resolve().then<unknown>(() => call())).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  }
  await expect(c.resolveAgentSession(f.principal, other.sessionId)).rejects.toMatchObject({ code: 'unauthenticated' });
});

test('org suspension and expiry invalidate existing sessions on the next call', async () => {
  const f = await connection('org');
  await admin.db.update(schema.organizations).set({ status: 'suspended' }).where(eq(schema.organizations.id, f.orgId));
  await expect(c.resolveAgentSession(f.principal, f.connected.sessionId)).rejects.toMatchObject({ code: 'org_suspended' });
  await admin.db.update(schema.organizations).set({ status: 'active' }).where(eq(schema.organizations.id, f.orgId));
  await admin.db.update(schema.agentTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(and(eq(schema.agentTokens.id, f.issued.token.id), eq(schema.agentTokens.orgId, f.orgId)));
  await expect(c.resolveAgentSession(f.principal, f.connected.sessionId)).rejects.toMatchObject({ code: 'unauthenticated' });
});

test('agent registration rejects missing or coerced names with a domain validation error', async () => {
  const f = await connection();
  for (const name of [undefined, null, 123, '', 'with spaces', 'a'.repeat(65)]) {
    await expect(Promise.resolve().then(() => c.connectAgent(f.principal, { name: name as string }))).rejects.toMatchObject({ code: 'validation_failed', details: { field: 'name' } });
  }
});
