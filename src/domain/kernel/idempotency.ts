import { and, eq } from 'drizzle-orm';
import type { DbTx } from '../../db/client';
import { idempotencyRecords } from '../../db/schema/ops';
import { DomainError } from './errors';
import { newId } from './ids';
import { canonicalJson, sha256Hex } from './safe-json';
import type { TxContext } from './tx';

const retentionMs = 48 * 60 * 60 * 1000;

/**
 * Runs `fn` at most once for (org, actor, operation, key) inside the caller's
 * transaction. The record is inserted before `fn` and updated with the response
 * before commit, so a concurrent caller blocks on the unique key. If this
 * transaction rolls back, the key is free. Same key + different payload throws
 * `idempotency_conflict`. The replayed value is JSON, not the original object.
 */
export async function withIdempotency<T>(
  tx: DbTx,
  ctx: TxContext,
  operation: string,
  key: string,
  payload: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const actor = actorOf(ctx);
  const requestHash = sha256Hex(canonicalJson(payload));
  const inserted = await tx.insert(idempotencyRecords).values({
    id: newId(),
    orgId: ctx.orgId,
    actorKind: actor.kind,
    actorId: actor.id,
    operation,
    idempotencyKey: key,
    requestHash,
    response: null,
    expiresAt: new Date(Date.now() + retentionMs),
  }).onConflictDoNothing({
    target: [
      idempotencyRecords.orgId,
      idempotencyRecords.actorKind,
      idempotencyRecords.actorId,
      idempotencyRecords.operation,
      idempotencyRecords.idempotencyKey,
    ],
  }).returning({ id: idempotencyRecords.id });

  if (!inserted[0]) {
    const existing = await tx.select({
      requestHash: idempotencyRecords.requestHash,
      response: idempotencyRecords.response,
    }).from(idempotencyRecords).where(and(
      eq(idempotencyRecords.orgId, ctx.orgId),
      eq(idempotencyRecords.actorKind, actor.kind),
      eq(idempotencyRecords.actorId, actor.id),
      eq(idempotencyRecords.operation, operation),
      eq(idempotencyRecords.idempotencyKey, key),
    )).limit(1);
    const row = existing[0];
    if (!row) throw new DomainError('unavailable');
    if (row.requestHash !== requestHash) throw new DomainError('idempotency_conflict');
    return readStored<T>(row.response);
  }

  const value = await fn();
  canonicalJson(value);
  await tx.update(idempotencyRecords).set({
    response: { v: 1, value },
  }).where(eq(idempotencyRecords.id, inserted[0].id));
  return value;
}

function readStored<T>(response: unknown): T {
  if (!response || typeof response !== 'object' || !('v' in response) || !('value' in response)) {
    throw new DomainError('unavailable');
  }
  const stored = response as { v: unknown; value: T };
  if (stored.v !== 1) throw new DomainError('unavailable');
  return stored.value;
}

function actorOf(ctx: TxContext): { kind: 'human' | 'agent' | 'system'; id: string } {
  const principal = ctx.principal;
  if (principal.kind === 'human') return { kind: 'human', id: principal.userId };
  if (principal.kind === 'agent') return { kind: 'agent', id: principal.tokenId };
  return { kind: 'system', id: 'system' };
}
