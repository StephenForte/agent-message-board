import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbTx } from '../../db/client';
import { user } from '../../db/schema/auth';
import { agents } from '../../db/schema/identity';
import { messages, messageRecipients } from '../../db/schema/messages';
import { assertProjectAccess, DomainError, isUuid, type TxContext } from '../kernel';

// Use the freshly re-read scope from withOrgTx, including when token scope changed.
export function accessPrincipal(ctx: TxContext) {
  const p = ctx.principal;
  return p.kind === 'agent' ? { ...p, scope: ctx.projectIds === 'all' ? 'org' as const : 'projects' as const, projectIds: ctx.projectIds } : p;
}

export type MessageRow = typeof messages.$inferSelect;
export async function rootRow(tx: DbTx, ctx: TxContext, rootId: string, mode: 'read' | 'write', lock = false) {
  if (!isUuid(rootId)) throw new DomainError('forbidden_or_not_found');
  const query = tx.select().from(messages).where(and(eq(messages.orgId, ctx.orgId), eq(messages.id, rootId)));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new DomainError('forbidden_or_not_found');
  const project = await assertProjectAccess(tx, accessPrincipal(ctx), row.projectId, mode);
  if (row.rootId !== null) throw new DomainError('validation_failed');
  return { row, project };
}
export function requireAuthor(ctx: TxContext) {
  const p = ctx.principal;
  if (p.kind === 'system' || (p.kind === 'agent' && (!p.agentId || !p.sessionId))) throw new DomainError('unauthenticated');
}
export async function author(tx: DbTx, ctx: TxContext) {
  requireAuthor(ctx);
  const p = ctx.principal;
  if (p.kind === 'human') {
    const [record] = await tx.select({ name: user.name }).from(user).where(eq(user.id, p.userId));
    if (!record) throw new DomainError('unauthenticated');
    return { authorKind: 'human', authorUserId: p.userId, authorDisplayName: record.name };
  }
  if (p.kind !== 'agent' || !p.agentId || !p.sessionId) throw new DomainError('unauthenticated');
  const [record] = await tx.select({ name: agents.name }).from(agents).where(and(eq(agents.orgId, ctx.orgId), eq(agents.id, p.agentId)));
  if (!record) throw new DomainError('unauthenticated');
  return { authorKind: 'agent', authorTokenId: p.tokenId, authorAgentId: p.agentId, authorSessionId: p.sessionId, authorDisplayName: record.name };
}
export async function validateRecipients(tx: DbTx, ctx: TxContext, ids: string[]) {
  if (!ids.length) return;
  const found = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.orgId, ctx.orgId), inArray(agents.id, ids)));
  if (found.length !== ids.length) throw new DomainError('validation_failed', { field: 'recipients' });
}
export async function addRecipients(tx: DbTx, ctx: TxContext, messageId: string, ids: string[]) {
  if (ids.length) await tx.insert(messageRecipients).values(ids.map((agentId) => ({ orgId: ctx.orgId, messageId, agentId })));
}
export async function recipientsFor(tx: DbTx, ctx: TxContext, ids: string[]) {
  if (!ids.length) return new Map<string, Array<{ id: string; name: string }>>();
  const rows = await tx.select({ messageId: messageRecipients.messageId, id: agents.id, name: agents.name })
    .from(messageRecipients).innerJoin(agents, and(eq(agents.orgId, messageRecipients.orgId), eq(agents.id, messageRecipients.agentId)))
    .where(and(eq(messageRecipients.orgId, ctx.orgId), inArray(messageRecipients.messageId, ids))).orderBy(agents.id);
  const result = new Map<string, Array<{ id: string; name: string }>>();
  for (const row of rows) result.set(row.messageId, [...(result.get(row.messageId) ?? []), { id: row.id, name: row.name }]);
  return result;
}
export function present(row: MessageRow, recipients: Array<{ id: string; name: string }>) {
  // searchVector is an internal generated column, never part of the public result.
  return {
    id: row.id, orgId: row.orgId, projectId: row.projectId, rootId: row.rootId, title: row.title, body: row.body,
    category: row.category, status: row.status, urgent: row.urgent, pinned: row.pinned, version: row.version,
    lastActivityAt: row.lastActivityAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    authorKind: row.authorKind, authorUserId: row.authorUserId, authorAgentId: row.authorAgentId,
    authorTokenId: row.authorTokenId, authorSessionId: row.authorSessionId, authorDisplayName: row.authorDisplayName, recipients,
  };
}
export function state(row: MessageRow) {
  return { status: row.status, urgent: row.urgent, pinned: row.pinned, version: row.version };
}
// Clock time, rather than transaction-start now(), preserves activity order after lock waits.
export const clock = sql`clock_timestamp()`;
