import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import * as c from '../../../src/domain/credentials';
import { newId, type Principal } from '../../../src/domain/kernel';
import { archiveProject, createProject } from '../../../src/domain/projects';
import * as schema from '../../../src/db/schema';
import { admin, fixture } from '../credentials/fixtures';
import { agentPrincipal, systemPrincipal } from '../helpers';
const auth = (secret: string) => c.authenticateBearer(`Bearer ${secret}`, { requestId: newId(), interface: 'mcp' });
const setup = (owner: Principal, projectId: string, agentName = 'Setup.Worker') => c.setupAgentConnection(owner, { agentName, clientLabel: 'Codex', token: { label: 'wizard', scope: 'projects', projectIds: [projectId] }, defaultProjectIds: [projectId] });
async function counts(orgId: string) {
  return Promise.all([schema.agents, schema.agentTokens, schema.agentProjectDefaults].map(async (table) => (await admin.db.select().from(table).where(eq(table.orgId, orgId))).length));
}
test('atomic setup creates identity, token and defaults; case-insensitive reuse and safe audits', async () => {
  const f = await fixture();
  const created = await setup(f.owner, f.projectId);
  const again = await setup(f.owner, f.projectId, 'setup.worker');
  expect(again.agent.id).toBe(created.agent.id);
  expect(again.token.id).not.toBe(created.token.id);
  expect(created.defaultProjectIds).toEqual([f.projectId]);
  const defaults = await c.getAgentDefaults(f.owner, created.agent.id);
  expect(defaults.map((p) => p.id)).toEqual([f.projectId]);
  const audits = await admin.db.select().from(schema.auditRecords).where(eq(schema.auditRecords.orgId, f.orgId));
  expect(audits.filter((a) => a.action === 'agent.register')).toHaveLength(1);
  expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['credential.create', 'agent.defaults']));
  const [row] = await admin.db.select().from(schema.agentTokens).where(eq(schema.agentTokens.id, created.token.id));
  expect(JSON.stringify(audits).includes(created.secret)).toBe(false);
  expect(JSON.stringify(audits).includes(row!.tokenHash)).toBe(false);
});
test('invalid scope/defaults and foreign projects roll back every setup row', async () => {
  const f = await fixture(); const other = await fixture();
  const before = await counts(f.orgId);
  await expect(c.setupAgentConnection(f.owner, { agentName: 'outside', token: { label: 'bad', scope: 'projects', projectIds: [] }, defaultProjectIds: [f.projectId] })).rejects.toMatchObject({ code: 'validation_failed' });
  expect(await counts(f.orgId)).toEqual(before);
  await expect(setup(f.owner, other.projectId)).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  expect(await counts(f.orgId)).toEqual(before);
  // Fails after inserting the new agent, proving the transaction rollback.
  await expect(c.setupAgentConnection(f.owner, { agentName: 'rollback', token: { label: '', scope: 'org' }, defaultProjectIds: [] })).rejects.toMatchObject({ code: 'validation_failed' });
  expect(await counts(f.orgId)).toEqual(before);
});
test('diagnostics include only sessions of this token, intersect defaults, and show archived read-only access', async () => {
  const f = await fixture(); const made = await setup(f.owner, f.projectId);
  const input = { agentId: made.agent.id, tokenId: made.token.id };
  expect((await c.getConnectionDiagnostics(f.owner, input)).sessions).toEqual([]);
  const connected = await c.connectAgent(await auth(made.secret), { name: made.agent.name, clientLabel: 'real-client' });
  const other = await c.createToken(f.owner, { label: 'other', scope: 'org' });
  await c.connectAgent(await auth(other.secret), { name: made.agent.name, clientLabel: 'other-token' });
  const outside = await createProject(f.owner, { name: 'Outside', slug: 'outside', idempotencyKey: newId() });
  await c.setAgentDefaults(f.owner, made.agent.id, [f.projectId, outside.id]);
  let result = await c.getConnectionDiagnostics(f.owner, input);
  expect(result.sessions.map((s) => s.id)).toEqual([connected.sessionId]);
  expect(result.sessions[0]!.clientLabel).toBe('real-client');
  expect(result.defaults.map((p) => p.id)).toEqual([f.projectId]);
  expect(result.projects.map((p) => p.id)).toEqual([f.projectId]);
  await archiveProject(f.owner, f.projectId);
  result = await c.getConnectionDiagnostics(f.owner, input);
  expect(result.projects[0]!.access).toBe('read-only');
  expect(result.defaults).toEqual([]);
  expect(result.capabilities.canCreateProjects).toBe(false);
  expect(JSON.stringify(result).includes(made.secret)).toBe(false);
  const broad = await c.getConnectionDiagnostics(f.owner, { agentId: made.agent.id, tokenId: other.token.id });
  expect(broad.projects.map((p) => p.id).sort()).toEqual([f.projectId, outside.id].sort());
});
test('foreign and missing diagnostic handles are indistinguishable; owner-only exports deny agents and system', async () => {
  const f = await fixture(); const other = await fixture();
  for (const input of [{ agentId: other.agentId, tokenId: f.tokenId }, { agentId: f.agentId, tokenId: other.tokenId }, { agentId: newId(), tokenId: f.tokenId }, { agentId: f.agentId, tokenId: newId() }]) {
    await expect(c.getConnectionDiagnostics(f.owner, input)).rejects.toMatchObject({ code: 'forbidden_or_not_found', details: {} });
  }
  for (const actor of [agentPrincipal(f), systemPrincipal(f.orgId)]) {
    await expect(Promise.resolve().then(() => setup(actor, f.projectId))).rejects.toMatchObject({ code: 'capability_denied' });
    await expect(Promise.resolve().then(() => c.getConnectionDiagnostics(actor, { agentId: f.agentId, tokenId: f.tokenId }))).rejects.toMatchObject({ code: 'capability_denied' });
  }
});
