import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { eq } from 'drizzle-orm';
import { afterAll, expect, test } from 'vitest';
import { user } from '../../../src/db/schema/auth';
import { organizations, ownerActivations } from '../../../src/db/schema/org';
import { siteAdmins } from '../../../src/db/schema/site-admins';
import { auditRecords } from '../../../src/db/schema/ops';
import { agentTokens } from '../../../src/db/schema/identity';
import { newId, withOrgBootstrapTx, withOrgTx, type HumanPrincipal, type AgentPrincipal } from '../../../src/domain/kernel';
import { provisionOrganization, associateOwner, issueOwnerActivation, consumeOwnerActivation,
  suspendOrganization, restoreOrganization, listOrganizationsForAdmin, humanLanding } from '../../../src/domain/organizations';
import { openDatabase, runtimeUrl, tokenPrefix } from '../helpers';

const runtime = openDatabase(runtimeUrl(), 8);
const db = runtime.db;
afterAll(() => runtime.pool.end());
async function human(verified = true) {
  const id = newId(); const email = `t03-${id}@example.com`;
  await db.insert(user).values({ id, email, name: 'T03', emailVerified: verified });
  const principal: HumanPrincipal = { kind: 'human', userId: id, orgId: null, siteAdmin: false, interface: 'web', requestId: `t03-${id}` };
  return { id, email, principal };
}
async function admin() {
  const person = await human(); await db.insert(siteAdmins).values({ userId: person.id });
  return { ...person, principal: { ...person.principal, siteAdmin: true } };
}
async function fixture() {
  const actor = await admin();
  const org = await provisionOrganization(actor.principal, { name: 'T03 organization' }, db);
  return { actor, org };
}
async function audits(orgId: string) {
  return withOrgBootstrapTx(orgId, (tx) => tx.select().from(auditRecords).where(eq(auditRecords.orgId, orgId)), db);
}

test('activation stores only SHA-256, expires in 72 hours, and audits without credentials', async () => {
  const { actor, org } = await fixture(); const owner = await human();
  const issued = await issueOwnerActivation(actor.principal, org.id, owner.email.toUpperCase(), db);
  expect(Buffer.from(issued.token, 'base64url')).toHaveLength(32);
  expect(issued.expiresAt.getTime() - Date.now()).toBeGreaterThan(71.99 * 3600000);
  const [stored] = await db.select().from(ownerActivations).where(eq(ownerActivations.orgId, org.id));
  expect(stored.tokenHash).toBe(createHash('sha256').update(issued.token).digest('hex'));
  expect(JSON.stringify(stored)).not.toContain(issued.token);
  await consumeOwnerActivation(owner.principal, issued.token, db);
  const rows = await audits(org.id);
  expect(rows.map((r) => r.action)).toEqual(['organization.provision', 'organization.issue_activation', 'organization.consume_activation']);
  expect(rows.slice(0, 2).every((r) => r.actorKind === 'human' && r.userId === actor.id)).toBe(true);
  expect(rows[2].userId).toBe(owner.id);
  expect(JSON.stringify(rows)).not.toContain(issued.token);
  expect(JSON.stringify(rows)).not.toContain(stored.tokenHash);
});

test('two concurrent consumers overlap on real connections: exactly one commits', async () => {
  const { actor, org } = await fixture(); const owner = await human();
  const issued = await issueOwnerActivation(actor.principal, org.id, owner.email, db);
  const blocker = await runtime.pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [org.id]);
  const consumers = [consumeOwnerActivation(owner.principal, issued.token, db), consumeOwnerActivation(owner.principal, issued.token, db)];
  const resultsPromise = Promise.allSettled(consumers);
  try {
    // Prove both transactions reached the database and are simultaneously blocked.
    let waiting = 0;
    for (let i = 0; i < 100; i++) {
      const result = await runtime.pool.query("select count(*)::int as n from pg_stat_activity where usename = current_user and wait_event_type = 'Lock' and query like '%organizations%'");
      waiting = result.rows[0].n;
      if (waiting >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBeGreaterThanOrEqual(2);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  const results = await resultsPromise;
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({ code: 'validation_failed' });
  await expect(consumeOwnerActivation(owner.principal, issued.token, db)).rejects.toMatchObject({ code: 'validation_failed' });
  const [stored] = await db.select().from(organizations).where(eq(organizations.id, org.id));
  expect(stored.ownerUserId).toBe(owner.id);
  expect((await audits(org.id)).filter((r) => r.action === 'organization.consume_activation')).toHaveLength(1);
});

test('expired links and revoked replacement links cannot activate', async () => {
  const { actor, org } = await fixture(); const owner = await human();
  const old = await issueOwnerActivation(actor.principal, org.id, owner.email, db);
  const current = await issueOwnerActivation(actor.principal, org.id, owner.email, db);
  await expect(consumeOwnerActivation(owner.principal, old.token, db)).rejects.toMatchObject({ code: 'validation_failed' });
  await db.update(ownerActivations).set({ expiresAt: new Date(0) }).where(eq(ownerActivations.orgId, org.id));
  await expect(consumeOwnerActivation(owner.principal, current.token, db)).rejects.toMatchObject({ code: 'validation_failed' });
});

test('activation is bound to the invited verified email, not principal flags or possession alone', async () => {
  const { actor, org } = await fixture(); const invited = await human(false); const other = await human();
  const issued = await issueOwnerActivation(actor.principal, org.id, invited.email, db);
  for (const principal of [other.principal, invited.principal]) {
    await expect(consumeOwnerActivation(principal, issued.token, db)).rejects.toMatchObject({ code: 'validation_failed' });
  }
  const [unused] = await db.select().from(ownerActivations).where(eq(ownerActivations.orgId, org.id));
  expect(unused.usedAt).toBeNull();
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, invited.id));
  await expect(consumeOwnerActivation(invited.principal, issued.token, db)).resolves.toEqual({ id: org.id });
});

test('every admin operation rejects non-admin and stale admin principals without writes', async () => {
  const { actor, org } = await fixture(); const outsider = await human();
  const operations = (p: HumanPrincipal) => [
    () => provisionOrganization(p, { name: `Denied ${outsider.id}` }, db),
    () => associateOwner(p, org.id, outsider.email, db),
    () => issueOwnerActivation(p, org.id, outsider.email, db),
    () => suspendOrganization(p, org.id, db), () => restoreOrganization(p, org.id, db),
    () => listOrganizationsForAdmin(p, db),
  ];
  const before = await db.select().from(organizations).where(eq(organizations.id, org.id));
  const auditBefore = await audits(org.id);
  await db.delete(siteAdmins).where(eq(siteAdmins.userId, actor.id));
  for (const p of [outsider.principal, actor.principal]) {
    for (const run of operations(p)) await expect(run()).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  }
  expect(await db.select().from(organizations).where(eq(organizations.id, org.id))).toEqual(before);
  expect(await db.select().from(organizations).where(eq(organizations.name, `Denied ${outsider.id}`))).toHaveLength(0);
  expect(await audits(org.id)).toEqual(auditBefore);
  expect(await db.select().from(ownerActivations).where(eq(ownerActivations.orgId, org.id))).toHaveLength(0);
});

test('suspension takes effect for human and agent on next request; restore re-enables both', async () => {
  const actor = await admin(); const owner = await human();
  const org = await provisionOrganization(actor.principal, { name: 'Suspend me', ownerEmail: owner.email }, db);
  const principal = { ...owner.principal, orgId: org.id };
  const tokenId = newId();
  await withOrgBootstrapTx(org.id, async (tx) => {
    await tx.insert(agentTokens).values({ id: tokenId, orgId: org.id, label: 'test', prefix: tokenPrefix(), tokenHash: 'a'.repeat(64), scope: 'org', createdByUserId: owner.id });
  }, db);
  const agent: AgentPrincipal = { kind: 'agent', orgId: org.id, tokenId, scope: 'org', projectIds: 'all', canCreateProjects: false, agentId: null, sessionId: null, interface: 'mcp', requestId: 't03-agent' };
  for (const p of [principal, agent]) await expect(withOrgTx(p, async () => true, db)).resolves.toBe(true);
  await suspendOrganization(actor.principal, org.id, db);
  expect(await humanLanding(principal, db)).toBe('/suspended');
  for (const p of [principal, agent]) await expect(withOrgTx(p, async () => true, db)).rejects.toMatchObject({ code: 'org_suspended' });
  await restoreOrganization(actor.principal, org.id, db);
  for (const p of [principal, agent]) await expect(withOrgTx(p, async () => true, db)).resolves.toBe(true);
  const rows = await audits(org.id);
  expect(rows.map((r) => r.action)).toEqual(['organization.provision', 'organization.suspend', 'organization.restore']);
  expect(rows.every((r) => r.userId === actor.id && r.actorKind === 'human')).toBe(true);
});

test('owner association is verified, one-org-only, audited, and invalidates invitations', async () => {
  const { actor, org } = await fixture(); const owner = await human(); const unverified = await human(false);
  const second = await provisionOrganization(actor.principal, { name: 'Second' }, db);
  await expect(associateOwner(actor.principal, org.id, unverified.email, db)).rejects.toMatchObject({ code: 'validation_failed' });
  const issued = await issueOwnerActivation(actor.principal, org.id, owner.email, db);
  await associateOwner(actor.principal, org.id, owner.email.toUpperCase(), db);
  await expect(associateOwner(actor.principal, second.id, owner.email, db)).rejects.toMatchObject({ code: 'validation_failed', details: { reason: 'This user already owns an organization' } });
  await expect(provisionOrganization(actor.principal, { name: 'Third', ownerEmail: owner.email }, db)).rejects.toMatchObject({ code: 'validation_failed' });
  await expect(consumeOwnerActivation(owner.principal, issued.token, db)).rejects.toMatchObject({ code: 'validation_failed' });
  expect((await audits(org.id)).filter((r) => r.action === 'organization.associate_owner')).toHaveLength(1);
  const [row] = await db.select().from(organizations).where(eq(organizations.id, second.id));
  expect(row.ownerUserId).toBeNull();
});

test('concurrent assignment across organizations returns validation rather than raw unique violation', async () => {
  const { actor, org } = await fixture(); const owner = await human();
  const second = await provisionOrganization(actor.principal, { name: 'Concurrent' }, db);
  const results = await Promise.allSettled([associateOwner(actor.principal, org.id, owner.email, db), associateOwner(actor.principal, second.id, owner.email, db)]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  expect(failed.reason).toMatchObject({ code: 'validation_failed' });
});

test('admin metadata contains only the documented fields; claim flag is not proof', async () => {
  const { actor, org } = await fixture();
  const rows = await listOrganizationsForAdmin({ ...actor.principal, siteAdmin: false }, db);
  const row = rows.find((r) => r.id === org.id)!;
  expect(Object.keys(row).sort()).toEqual(['createdAt', 'id', 'name', 'ownerEmail', 'status']);
  expect(await humanLanding(actor.principal, db)).toBe('/no-organization');
});

test('CLI grants only existing verified users and is idempotent', async () => {
  const verified = await human(); const unverified = await human(false);
  const run = (email: string) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/admin-grant.ts', email], {
    env: { ...process.env, DATABASE_URL: runtimeUrl() }, encoding: 'utf8', timeout: 10000,
  });
  expect(run(verified.email).status).toBe(0);
  expect(run(verified.email.toUpperCase()).status).toBe(0);
  expect(await db.select().from(siteAdmins).where(eq(siteAdmins.userId, verified.id))).toHaveLength(1);
  for (const email of [unverified.email, 'not-present@example.com']) {
    const result = run(email); expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('existing verified user');
  }
  expect(await db.select().from(siteAdmins).where(eq(siteAdmins.userId, unverified.id))).toHaveLength(0);
});
