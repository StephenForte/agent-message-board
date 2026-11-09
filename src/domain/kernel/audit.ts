import type { DbTx } from '../../db/client';
import { auditRecords } from '../../db/schema/ops';
import { newId } from './ids';
import { assertSafeJson } from './safe-json';
import type { TxContext } from './tx';

export type AuditRecord = {
  action: string;
  entityType: string;
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
};

/** Same transaction as the mutation. Refuses secret-shaped JSON and message bodies. */
export async function writeAudit(tx: DbTx, ctx: TxContext, record: AuditRecord): Promise<void> {
  if (record.before) assertSafeJson(record.before, 12_000);
  if (record.after) assertSafeJson(record.after, 12_000);
  const actor = actorColumns(ctx);
  await tx.insert(auditRecords).values({
    id: newId(),
    orgId: ctx.orgId,
    actorKind: actor.actorKind,
    userId: actor.userId,
    tokenId: actor.tokenId,
    agentId: actor.agentId,
    sessionId: actor.sessionId,
    interfaceKind: ctx.principal.interface,
    requestId: ctx.requestId,
    action: record.action,
    entityType: record.entityType,
    entityId: record.entityId,
    before: record.before ?? null,
    after: record.after ?? null,
  });
}

function actorColumns(ctx: TxContext): {
  actorKind: 'human' | 'agent' | 'system';
  userId: string | null;
  tokenId: string | null;
  agentId: string | null;
  sessionId: string | null;
} {
  const principal = ctx.principal;
  if (principal.kind === 'human') {
    return { actorKind: 'human', userId: principal.userId, tokenId: null, agentId: null, sessionId: null };
  }
  if (principal.kind === 'agent') {
    return {
      actorKind: 'agent',
      userId: null,
      tokenId: principal.tokenId,
      agentId: principal.agentId,
      sessionId: principal.sessionId,
    };
  }
  return { actorKind: 'system', userId: null, tokenId: null, agentId: null, sessionId: null };
}
