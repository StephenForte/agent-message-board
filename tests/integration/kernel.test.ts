import { eq } from 'drizzle-orm';
import { afterAll, expect, test } from 'vitest';
import * as schema from '../../src/db/schema/index';
import { accessibleProjectIds, assertProjectAccess } from '../../src/domain/kernel/authz';
import { writeAudit } from '../../src/domain/kernel/audit';
import { DomainError } from '../../src/domain/kernel/errors';
import { appendEvents, currentWatermark, readEventsAfter } from '../../src/domain/kernel/events';
import { withIdempotency } from '../../src/domain/kernel/idempotency';
import { newId } from '../../src/domain/kernel/ids';
import { setLocal, withOrgTx } from '../../src/domain/kernel/tx';
import { agentPrincipal, openDatabase, runtimeUrl, seedOrg, systemPrincipal, adminUrl } from './helpers';

const admin = openDatabase(adminUrl());
const runtime = openDatabase(runtimeUrl(), 6);

afterAll(async () => {
  await admin.pool.end();
  await runtime.pool.end();
});

test('property 1: a reader never observes a seq that is still uncommitted', async () => {
  const seed = await seedOrg(admin.db, 'cursor');
  let release = () => {};
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let arm = () => {};
  const armed = new Promise<void>((resolve) => { arm = resolve; });
  const txA = runtime.db.transaction(async (tx) => {
    await setLocal(tx, 'app.org_id', seed.orgId);
    const seqs = await appendEvents(tx, seed.orgId, [{ kind: 'project.created', projectId: seed.projectId }]);
    arm();
    await hold;
    return seqs[0];
  });
  const txB = (async () => {
    await armed;
    return runtime.db.transaction(async (tx) => {
      await setLocal(tx, 'app.org_id', seed.orgId);
      const seqs = await appendEvents(tx, seed.orgId, [{ kind: 'project.updated', projectId: seed.projectId }]);
      return seqs[0];
    });
  })();
  await armed;
  const blocked = waitForCounterLock();
  const finishedEarly = txB.then(() => 'finished' as const);
  expect(await Promise.race([blocked.then(() => 'blocked' as const), finishedEarly])).toBe('blocked');
  const mid = await runtime.db.transaction(async (tx) => {
    await setLocal(tx, 'app.org_id', seed.orgId);
    return {
      watermark: await currentWatermark(tx, seed.orgId),
      events: await readEventsAfter(tx, seed.orgId, 0, 10),
    };
  });
  expect(mid.watermark).toBe(0);
  expect(mid.events).toEqual([]);
  release();
  const [seqA, seqB] = await Promise.all([txA, txB]);
  expect(seqA).toBe(1);
  expect(seqB).toBe(2);
  const final = await runtime.db.transaction(async (tx) => {
    await setLocal(tx, 'app.org_id', seed.orgId);
    return {
      watermark: await currentWatermark(tx, seed.orgId),
      events: await readEventsAfter(tx, seed.orgId, 0, 10),
    };
  });
  expect(final.watermark).toBe(2);
  expect(final.events.map((event) => event.kind)).toEqual(['project.created', 'project.updated']);
});

test('property 5: a failure after write, event, and audit rolls all three back', async () => {
  const seed = await seedOrg(admin.db, 'atomic');
  const projectId = newId();
  await expect(withOrgTx(systemPrincipal(seed.orgId), async (tx, ctx) => {
    await tx.insert(schema.projects).values({
      id: projectId, orgId: seed.orgId, slug: 'gamma', name: 'Gamma', status: 'active',
      createdByKind: 'human', createdByUserId: seed.userId,
    });
    await appendEvents(tx, seed.orgId, [{ kind: 'project.created', projectId }]);
    await writeAudit(tx, ctx, { action: 'project.create', entityType: 'project', entityId: projectId });
    throw new Error('forced failure');
  }, runtime.db)).rejects.toThrow('forced failure');
  const projects = await admin.db.select({ id: schema.projects.id }).from(schema.projects).where(eq(schema.projects.id, projectId));
  const events = await admin.db.select({ seq: schema.events.seq }).from(schema.events).where(eq(schema.events.orgId, seed.orgId));
  const audits = await admin.db.select({ id: schema.auditRecords.id }).from(schema.auditRecords).where(eq(schema.auditRecords.orgId, seed.orgId));
  const counter = await admin.db.select({ lastSeq: schema.orgEventCounters.lastSeq }).from(schema.orgEventCounters).where(eq(schema.orgEventCounters.orgId, seed.orgId));
  expect(projects).toEqual([]);
  expect(events).toEqual([]);
  expect(audits).toEqual([]);
  expect(counter[0]?.lastSeq).toBe(0);
});

test('property 6: idempotency replays, conflicts, collapses concurrency, and survives rollback', async () => {
  const seed = await seedOrg(admin.db, 'idem');
  const principal = systemPrincipal(seed.orgId);
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = 0;
  const run = () => withOrgTx(principal, (tx, ctx) => withIdempotency(tx, ctx, 'mark', 'same', { n: 1 }, async () => {
    entered += 1;
    if (entered === 1) await gate;
    await appendEvents(tx, seed.orgId, [{ kind: 'project.updated', projectId: seed.projectId, payload: { n: 1 } }]);
    return { ok: true, n: 1 };
  }), runtime.db);
  const both = Promise.all([run(), run()]);
  await waitFor(() => entered === 1);
  await delay(150);
  expect(entered).toBe(1);
  release();
  const [first, second] = await both;
  expect(first).toEqual({ ok: true, n: 1 });
  expect(second).toEqual({ ok: true, n: 1 });
  expect(entered).toBe(1);
  const replay = await withOrgTx(principal, (tx, ctx) => withIdempotency(
    tx, ctx, 'mark', 'same', { n: 1 }, async () => { entered += 1; return { ok: false, n: 1 }; },
  ), runtime.db);
  expect(replay).toEqual({ ok: true, n: 1 });
  expect(entered).toBe(1);
  await expect(withOrgTx(principal, (tx, ctx) => withIdempotency(
    tx, ctx, 'mark', 'same', { n: 2 }, async () => ({ ok: true, n: 2 }),
  ), runtime.db)).rejects.toMatchObject({ code: 'idempotency_conflict' });

  await expect(withOrgTx(principal, (tx, ctx) => withIdempotency(tx, ctx, 'mark', 'rollback', { n: 1 }, async () => {
    await appendEvents(tx, seed.orgId, [{ kind: 'project.archived', projectId: seed.projectId }]);
    throw new Error('rollback');
  }), runtime.db)).rejects.toThrow('rollback');
  const afterRollback = await withOrgTx(principal, (tx, ctx) => withIdempotency(tx, ctx, 'mark', 'rollback', { n: 1 }, async () => {
    await appendEvents(tx, seed.orgId, [{ kind: 'project.restored', projectId: seed.projectId }]);
    return { restored: true };
  }), runtime.db);
  expect(afterRollback).toEqual({ restored: true });
  const events = await admin.db.select({ kind: schema.events.kind }).from(schema.events).where(eq(schema.events.orgId, seed.orgId));
  expect(events.map((event) => event.kind).sort()).toEqual(['project.restored', 'project.updated']);
});

test('property 7: the next call sees a suspended org, dead token, and removed grant', async () => {
  const seed = await seedOrg(admin.db, 'fresh');
  const principal = agentPrincipal(seed);
  await expect(withOrgTx(principal, async () => 'ok', runtime.db)).resolves.toBe('ok');

  await admin.db.update(schema.organizations).set({ status: 'suspended' }).where(eq(schema.organizations.id, seed.orgId));
  await expect(withOrgTx(principal, async () => 'ok', runtime.db)).rejects.toMatchObject({ code: 'org_suspended' });
  await admin.db.update(schema.organizations).set({ status: 'active' }).where(eq(schema.organizations.id, seed.orgId));

  await admin.db.update(schema.agentTokens).set({ revokedAt: new Date() }).where(eq(schema.agentTokens.id, seed.tokenId));
  await expect(withOrgTx(principal, async () => 'ok', runtime.db)).rejects.toMatchObject({ code: 'unauthenticated' });
  await admin.db.update(schema.agentTokens).set({ revokedAt: null }).where(eq(schema.agentTokens.id, seed.tokenId));

  await admin.db.update(schema.agentTokens).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.agentTokens.id, seed.tokenId));
  await expect(withOrgTx(principal, async () => 'ok', runtime.db)).rejects.toMatchObject({ code: 'unauthenticated' });
  await admin.db.update(schema.agentTokens).set({ expiresAt: null }).where(eq(schema.agentTokens.id, seed.tokenId));

  await admin.db.delete(schema.tokenProjectGrants).where(eq(schema.tokenProjectGrants.tokenId, seed.tokenId));
  await expect(withOrgTx(principal, async () => 'ok', runtime.db)).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
});

test('defaults do not widen project access, and archived writes are rejected', async () => {
  const seed = await seedOrg(admin.db, 'authz');
  const hidden = newId();
  await admin.db.insert(schema.projects).values({
    id: hidden, orgId: seed.orgId, slug: 'hidden', name: 'Hidden', status: 'active',
    createdByKind: 'human', createdByUserId: seed.userId,
  });
  await admin.db.insert(schema.agentProjectDefaults).values({
    orgId: seed.orgId, agentId: seed.agentId, projectId: hidden,
  });
  const principal = agentPrincipal(seed);
  const ids = await withOrgTx(principal, (tx) => accessibleProjectIds(tx, principal, { includeArchived: true }), runtime.db);
  expect(ids).toContain(seed.projectId);
  expect(ids).not.toContain(hidden);
  await expect(withOrgTx(principal, (tx) => assertProjectAccess(tx, principal, hidden, 'read'), runtime.db))
    .rejects.toBeInstanceOf(DomainError);

  await admin.db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, seed.projectId));
  const readable = await withOrgTx(principal, (tx) => assertProjectAccess(tx, principal, seed.projectId, 'read'), runtime.db);
  expect(readable.status).toBe('archived');
  await expect(withOrgTx(principal, (tx) => assertProjectAccess(tx, principal, seed.projectId, 'write'), runtime.db))
    .rejects.toMatchObject({ code: 'project_archived' });
});

async function waitForCounterLock(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 5_000) {
    const result = await admin.pool.query<{ n: number }>(`
      select count(*)::int as n
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and query ilike '%org_event_counters%'
    `);
    if ((result.rows[0]?.n ?? 0) > 0) return;
    await delay(40);
  }
  throw new Error('timed out waiting for the event-counter lock');
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 5_000) throw new Error('timed out waiting for condition');
    await delay(20);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
