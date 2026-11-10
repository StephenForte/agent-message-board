import { and, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, expect, test } from 'vitest';
import { closeDb } from '../../../src/db/client';
import * as schema from '../../../src/db/schema';
import * as credentials from '../../../src/domain/credentials';
import { SESSION_SEEN_AUDIT_INTERVAL_MS } from '../../../src/domain/credentials';
import { newId, withIdempotency, withOrgMaintenanceTx, withOrgTx, type HumanPrincipal } from '../../../src/domain/kernel';
import {
  RATE_LIMIT_WINDOW_MS, RETENTION_ADVISORY_LOCK_CLASS_ID, RETENTION_ADVISORY_LOCK_OBJECT_ID,
  SESSION_SEEN_RETENTION_MS, runRetention,
} from '../../../src/domain/retention';
import { adminUrl, insertRoot, openDatabase, runtimeUrl, seedOrg, sha256Hex, type TestDatabase } from '../helpers';

process.env.DATABASE_URL = runtimeUrl();
const admin = openDatabase(adminUrl(), 4);
const NOW = new Date('2026-11-10T18:00:30.000Z');

afterAll(async () => {
  await closeDb();
  await admin.pool.end();
});

type Seed = Awaited<ReturnType<typeof seedOrg>> & { owner: HumanPrincipal };

async function makeOrg(name: string): Promise<Seed> {
  const seed = await seedOrg(admin.db, name);
  const owner: HumanPrincipal = {
    kind: 'human', orgId: seed.orgId, userId: seed.userId, siteAdmin: false, requestId: `t18-${name}`, interface: 'web',
  };
  return { ...seed, owner };
}

async function ids(db: TestDatabase, orgId: string) {
  const idempotency = await db.select({ id: schema.idempotencyRecords.id }).from(schema.idempotencyRecords).where(eq(schema.idempotencyRecords.orgId, orgId));
  const windows = await db.select({ start: schema.rateLimitWindows.windowStart }).from(schema.rateLimitWindows).where(eq(schema.rateLimitWindows.orgId, orgId));
  const audits = await db.select({ id: schema.auditRecords.id, action: schema.auditRecords.action }).from(schema.auditRecords).where(eq(schema.auditRecords.orgId, orgId));
  const messages = await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.orgId, orgId));
  const events = await db.select({ seq: schema.events.seq }).from(schema.events).where(eq(schema.events.orgId, orgId));
  const announcements = await db.select({ id: schema.announcements.id }).from(schema.announcements).where(eq(schema.announcements.orgId, orgId));
  return {
    idempotency: idempotency.map((row) => row.id).sort(),
    windows: windows.map((row) => row.start.toISOString()).sort(),
    audits: audits.map((row) => `${row.action}:${row.id}`).sort(),
    messages: messages.map((row) => row.id).sort(),
    events: events.map((row) => row.seq).sort(),
    announcements: announcements.map((row) => row.id).sort(),
  };
}

test('the runtime role is not a superuser and does not bypass RLS', async () => {
  const client = new pg.Client({ connectionString: runtimeUrl() });
  await client.connect();
  try {
    const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
    );
    expect(role.rows[0]?.rolsuper).toBe(false);
    expect(role.rows[0]?.rolbypassrls).toBe(false);
  } finally {
    await client.end();
  }
});

test('session activity is audited once per 15 minutes and last_seen_at still moves', async () => {
  const org = await makeOrg('t18-throttle');
  const issued = await credentials.createToken(org.owner, { label: 'throttle', scope: 'org' });
  const principal = await credentials.authenticateBearer(`Bearer ${issued.secret}`, { requestId: 't18-throttle', interface: 'mcp' });
  const connected = await credentials.connectAgent(principal, { name: 'throttle-agent' });

  const seen = async (sessionId: string) => admin.db.select({ id: schema.auditRecords.id }).from(schema.auditRecords).where(and(
    eq(schema.auditRecords.entityId, sessionId), eq(schema.auditRecords.action, 'agent.session_seen'),
  ));
  for (let call = 0; call < 3; call += 1) {
    await admin.db.update(schema.agentSessions).set({ lastSeenAt: new Date(0) }).where(eq(schema.agentSessions.id, connected.sessionId));
    await admin.db.update(schema.agents).set({ lastSeenAt: new Date(0) }).where(eq(schema.agents.id, connected.agent.id));
    const before = new Date();
    await credentials.resolveAgentSession(principal, connected.sessionId);
    const [session] = await admin.db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, connected.sessionId));
    const [agent] = await admin.db.select().from(schema.agents).where(eq(schema.agents.id, connected.agent.id));
    expect(session!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(agent!.lastSeenAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
  }
  const [afterThird] = await admin.db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, connected.sessionId));
  expect(await seen(connected.sessionId)).toHaveLength(1);
  expect(afterThird!.lastSeenAuditedAt).not.toBeNull();
  const auditedAt = afterThird!.lastSeenAuditedAt!.getTime();

  await credentials.resolveAgentSession(principal, connected.sessionId);
  const [still] = await admin.db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, connected.sessionId));
  expect(still!.lastSeenAuditedAt!.getTime()).toBe(auditedAt);
  expect(await seen(connected.sessionId)).toHaveLength(1);

  await admin.db.update(schema.agentSessions).set({
    lastSeenAuditedAt: new Date(Date.now() - SESSION_SEEN_AUDIT_INTERVAL_MS - 60_000),
  }).where(eq(schema.agentSessions.id, connected.sessionId));
  await credentials.resolveAgentSession(principal, connected.sessionId);
  expect(await seen(connected.sessionId)).toHaveLength(2);

  const fresh = await credentials.connectAgent(principal, { name: 'throttle-agent', clientLabel: 'concurrent' });
  await Promise.all(Array.from({ length: 20 }, (_, index) => credentials.resolveAgentSession(
    { ...principal, requestId: `t18-concurrent-${index}` }, fresh.sessionId,
  )));
  expect(await seen(fresh.sessionId)).toHaveLength(1);
});

test('purge keeps the live boundaries in two organizations and drops only what is past use', async () => {
  const orgs = [await makeOrg('t18-bound-a'), await makeOrg('t18-bound-b')];
  for (const org of orgs) {
    let calls = 0;
    await withOrgTx(org.owner, (tx, ctx) => withIdempotency(tx, ctx, 'retention.replay', 'live', { n: 1 }, async () => {
      calls += 1;
      return { id: 'kept' };
    }));
    expect(calls).toBe(1);
    await withOrgMaintenanceTx(org.orgId, async (tx) => {
      await tx.update(schema.idempotencyRecords).set({ expiresAt: new Date(NOW.getTime() + 1000) }).where(eq(schema.idempotencyRecords.idempotencyKey, 'live'));
      await tx.insert(schema.idempotencyRecords).values({
        id: newId(), orgId: org.orgId, actorKind: 'human', actorId: org.userId, operation: 'retention.replay',
        idempotencyKey: 'expired', requestHash: sha256Hex(), response: { v: 1, value: { id: 'gone' } },
        expiresAt: new Date(NOW.getTime() - 1000),
      });
      await tx.insert(schema.rateLimitWindows).values([
        { orgId: org.orgId, tokenId: org.tokenId, bucket: 'read', windowStart: new Date('2026-11-10T18:00:00.000Z'), count: 4 },
        { orgId: org.orgId, tokenId: org.tokenId, bucket: 'read', windowStart: new Date(NOW.getTime() - 59 * 60 * 1000 - RATE_LIMIT_WINDOW_MS), count: 2 },
        { orgId: org.orgId, tokenId: org.tokenId, bucket: 'read', windowStart: new Date(NOW.getTime() - 61 * 60 * 1000 - RATE_LIMIT_WINDOW_MS), count: 9 },
      ]);
      await tx.insert(schema.auditRecords).values([
        audit(org, 'agent.session_seen', new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000)),
        audit(org, 'agent.session_seen', new Date(NOW.getTime() - SESSION_SEEN_RETENTION_MS + 24 * 60 * 60 * 1000)),
        audit(org, 'message.created', new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000), 'human'),
      ]);
      await tx.insert(schema.events).values({
        orgId: org.orgId, seq: 1, kind: 'project.created', projectId: org.projectId, payload: { name: 'kept' },
      });
      await tx.insert(schema.announcements).values({
        id: newId(), scope: 'org', orgId: org.orgId, title: 'keep', body: 'keep', version: 1, authorUserId: org.userId,
      });
    });
    await insertRoot(admin.db, org, 'kept');
  }

  const before = await Promise.all(orgs.map((org) => ids(admin.db, org.orgId)));
  const report = await runRetention({ now: NOW });
  expect(report.skipped).toBe(false);
  const after = await Promise.all(orgs.map((org) => ids(admin.db, org.orgId)));

  for (const [index, org] of orgs.entries()) {
    const prior = before[index]!;
    const next = after[index]!;
    expect(next.idempotency).toHaveLength(1);
    expect(next.windows).toEqual([
      new Date(NOW.getTime() - 59 * 60 * 1000 - RATE_LIMIT_WINDOW_MS).toISOString(),
      '2026-11-10T18:00:00.000Z',
    ].sort());
    expect(next.audits.filter((row) => row.startsWith('agent.session_seen'))).toHaveLength(1);
    expect(next.audits.filter((row) => row.startsWith('message.created'))).toHaveLength(1);
    expect(next.messages).toEqual(prior.messages);
    expect(next.events).toEqual(prior.events);
    expect(next.announcements).toEqual(prior.announcements);
    expect(next.messages).toHaveLength(1);
    expect(next.events).toEqual([1]);
    expect(next.announcements).toHaveLength(1);

    let replayCalls = 0;
    const replayed = await withOrgTx(org.owner, (tx, ctx) => withIdempotency(tx, ctx, 'retention.replay', 'live', { n: 1 }, async () => {
      replayCalls += 1;
      return { id: 'duplicate' };
    }));
    expect(replayed).toEqual({ id: 'kept' });
    expect(replayCalls).toBe(0);
    let expiredCalls = 0;
    const renewed = await withOrgTx(org.owner, (tx, ctx) => withIdempotency(tx, ctx, 'retention.replay', 'expired', { n: 1 }, async () => {
      expiredCalls += 1;
      return { id: 'fresh' };
    }));
    expect(renewed).toEqual({ id: 'fresh' });
    expect(expiredCalls).toBe(1);
  }
});

test('batches delete every expired row and the per-table count is exact', async () => {
  const orgs = [await makeOrg('t18-batch-a'), await makeOrg('t18-batch-b')];
  const plan = [3, 2];
  for (const [index, org] of orgs.entries()) {
    await withOrgMaintenanceTx(org.orgId, async (tx) => {
      await tx.insert(schema.idempotencyRecords).values(Array.from({ length: plan[index]! }, (_, row) => ({
        id: newId(), orgId: org.orgId, actorKind: 'human' as const, actorId: org.userId, operation: 'retention.batch',
        idempotencyKey: `expired-${row}`, requestHash: sha256Hex(), response: { v: 1, value: { row } },
        expiresAt: new Date(NOW.getTime() - 60_000),
      })));
      await tx.insert(schema.idempotencyRecords).values({
        id: newId(), orgId: org.orgId, actorKind: 'human', actorId: org.userId, operation: 'retention.batch',
        idempotencyKey: 'live', requestHash: sha256Hex(), response: { v: 1, value: { ok: true } },
        expiresAt: new Date(NOW.getTime() + 60_000),
      });
      await tx.insert(schema.rateLimitWindows).values([
        ...Array.from({ length: plan[index]! }, (_, row) => ({
          orgId: org.orgId, tokenId: org.tokenId, bucket: 'read',
          windowStart: new Date(NOW.getTime() - (120 + row) * 60 * 1000), count: 1,
        })),
        { orgId: org.orgId, tokenId: org.tokenId, bucket: 'write', windowStart: new Date('2026-11-10T18:00:00.000Z'), count: 3 },
      ]);
      await tx.insert(schema.auditRecords).values([
        ...Array.from({ length: plan[index]! }, () => audit(org, 'agent.session_seen', new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000))),
        audit(org, 'message.created', new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000), 'human'),
      ]);
    });
  }

  const report = await runRetention({ now: NOW, batchSize: 2 });
  expect(report).toEqual({ skipped: false, idempotencyRecords: 5, rateLimitWindows: 5, sessionSeen: 5 });
  for (const org of orgs) {
    const left = await ids(admin.db, org.orgId);
    expect(left.idempotency).toHaveLength(1);
    expect(left.windows).toEqual(['2026-11-10T18:00:00.000Z']);
    expect(left.audits.filter((row) => row.startsWith('message.created'))).toHaveLength(1);
    expect(left.audits.filter((row) => row.startsWith('agent.session_seen'))).toHaveLength(0);
  }
});

test('a second concurrent retention run is skipped while the advisory lock is held', async () => {
  const org = await makeOrg('t18-lock');
  const expiredId = newId();
  await withOrgMaintenanceTx(org.orgId, async (tx) => {
    await tx.insert(schema.idempotencyRecords).values({
      id: expiredId, orgId: org.orgId, actorKind: 'human', actorId: org.userId, operation: 'retention.lock',
      idempotencyKey: 'expired', requestHash: sha256Hex(), response: { v: 1, value: null },
      expiresAt: new Date(NOW.getTime() - 1000),
    });
  });
  const locker = new pg.Client({ connectionString: runtimeUrl() });
  await locker.connect();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await locker.query('rollback').catch(() => undefined);
    await locker.end().catch(() => undefined);
  };
  try {
    await locker.query('begin');
    await locker.query(`select set_config('app.org_id', $1, true)`, [org.orgId]);
    const locked = await locker.query('select id from idempotency_records where id = $1 for update', [expiredId]);
    expect(locked.rows).toHaveLength(1);
    let settled = false;
    const first = runRetention({ now: NOW }).then((report) => {
      settled = true;
      return report;
    }, (error: unknown) => {
      settled = true;
      throw error;
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      const held = await admin.pool.query<{ n: number }>(
        `select count(*)::int as n from pg_locks
         where locktype = 'advisory' and classid = $1 and objid = $2 and objsubid = 2 and granted`,
        [RETENTION_ADVISORY_LOCK_CLASS_ID, RETENTION_ADVISORY_LOCK_OBJECT_ID],
      );
      if ((held.rows[0]?.n ?? 0) > 0) break;
      if (Date.now() > deadline) throw new Error('advisory lock was not held');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    const second = await runRetention({ now: NOW });
    expect(second).toEqual({ skipped: true, idempotencyRecords: 0, rateLimitWindows: 0, sessionSeen: 0 });
    const during = await admin.db.select({ id: schema.idempotencyRecords.id }).from(schema.idempotencyRecords).where(eq(schema.idempotencyRecords.id, expiredId));
    expect(during).toHaveLength(1);
    await release();
    const report = await first;
    expect(report.skipped).toBe(false);
    expect(report.idempotencyRecords).toBeGreaterThanOrEqual(1);
    const gone = await admin.db.select({ id: schema.idempotencyRecords.id }).from(schema.idempotencyRecords).where(eq(schema.idempotencyRecords.id, expiredId));
    expect(gone).toHaveLength(0);
  } finally {
    await release();
  }
});

function audit(org: Seed, action: string, createdAt: Date, kind: 'agent' | 'human' = 'agent') {
  return {
    id: newId(), orgId: org.orgId, actorKind: kind,
    userId: kind === 'human' ? org.userId : null,
    tokenId: kind === 'agent' ? org.tokenId : null,
    agentId: kind === 'agent' ? org.agentId : null,
    sessionId: kind === 'agent' ? org.sessionId : null,
    interfaceKind: kind === 'agent' ? 'mcp' as const : 'web' as const,
    requestId: 't18-retention', action, entityType: kind === 'agent' ? 'agent_session' : 'message',
    entityId: kind === 'agent' ? org.sessionId : org.projectId, createdAt,
  };
}
