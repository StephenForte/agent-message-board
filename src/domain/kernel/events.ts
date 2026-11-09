import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { DbTx } from '../../db/client';
import { events } from '../../db/schema/ops';
import { orgEventCounters } from '../../db/schema/org';
import { DomainError } from './errors';
import { assertSafeJson } from './safe-json';

export const eventKinds = [
  'message.created',
  'message.replied',
  'message.flag_changed',
  'message.archived',
  'message.restored',
  'project.created',
  'project.updated',
  'project.archived',
  'project.restored',
  'access.changed',
] as const;

export type EventKind = (typeof eventKinds)[number];

export type KernelEvent = {
  kind: EventKind;
  projectId?: string | null;
  messageId?: string | null;
  rootId?: string | null;
  agentId?: string | null;
  tokenId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  payload?: Record<string, unknown>;
};

/**
 * Allocates seqs with the org counter row lock inside the caller's transaction.
 * Commit order within an org equals seq order. Do not call this on another connection.
 * `access.changed` means clients must resync; announcement freshness is not an event.
 */
export async function appendEvents(tx: DbTx, orgId: string, batch: KernelEvent[]): Promise<number[]> {
  if (batch.length === 0) return [];
  await assertSessionOrg(tx, orgId);
  for (const event of batch) {
    if (!eventKinds.includes(event.kind)) throw new DomainError('validation_failed', { field: 'kind' });
    assertSafeJson(event.payload ?? {}, 4096);
  }
  const updated = await tx.update(orgEventCounters).set({
    lastSeq: sql`${orgEventCounters.lastSeq} + ${batch.length}`,
  }).where(eq(orgEventCounters.orgId, orgId)).returning({ lastSeq: orgEventCounters.lastSeq });
  const last = updated[0]?.lastSeq;
  if (last === undefined) throw new DomainError('forbidden_or_not_found');
  const start = last - batch.length + 1;
  await tx.insert(events).values(batch.map((event, index) => ({
    orgId,
    seq: start + index,
    kind: event.kind,
    projectId: event.projectId ?? null,
    messageId: event.messageId ?? null,
    rootId: event.rootId ?? null,
    agentId: event.agentId ?? null,
    tokenId: event.tokenId ?? null,
    entityType: event.entityType ?? null,
    entityId: event.entityId ?? null,
    payload: event.payload ?? {},
  })));
  return batch.map((_, index) => start + index);
}

/** Highest committed counter value visible to this transaction. Never a seq that is still open. */
export async function currentWatermark(tx: DbTx, orgId: string): Promise<number> {
  await assertSessionOrg(tx, orgId);
  const rows = await tx.select({ lastSeq: orgEventCounters.lastSeq }).from(orgEventCounters).where(eq(orgEventCounters.orgId, orgId)).limit(1);
  const last = rows[0]?.lastSeq;
  if (last === undefined) throw new DomainError('forbidden_or_not_found');
  return last;
}

export async function readEventsAfter(tx: DbTx, orgId: string, afterSeq: number, limit: number): Promise<Array<{
  seq: number;
  kind: EventKind;
  projectId: string | null;
  messageId: string | null;
  rootId: string | null;
  agentId: string | null;
  tokenId: string | null;
  entityType: string | null;
  entityId: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}>> {
  await assertSessionOrg(tx, orgId);
  if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new DomainError('validation_failed', { field: 'afterSeq' });
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError('validation_failed', { field: 'limit' });
  const rows = await tx.select({
    seq: events.seq,
    kind: events.kind,
    projectId: events.projectId,
    messageId: events.messageId,
    rootId: events.rootId,
    agentId: events.agentId,
    tokenId: events.tokenId,
    entityType: events.entityType,
    entityId: events.entityId,
    payload: events.payload,
    createdAt: events.createdAt,
  }).from(events).where(and(
    eq(events.orgId, orgId),
    gt(events.seq, afterSeq),
  )).orderBy(asc(events.seq)).limit(limit);
  return rows.map((row) => ({
    ...row,
    kind: row.kind as EventKind,
    payload: (row.payload ?? {}) as Record<string, unknown>,
  }));
}

async function assertSessionOrg(tx: DbTx, orgId: string): Promise<void> {
  const result = await tx.execute(sql`select current_setting('app.org_id', true) as org_id`);
  const current = result.rows[0]?.org_id;
  if (current !== orgId) throw new DomainError('forbidden_or_not_found');
}
