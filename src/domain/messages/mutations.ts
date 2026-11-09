import { and, eq } from 'drizzle-orm';
import { messages } from '../../db/schema/messages';
import { appendEvents, assertProjectAccess, DomainError, newId, versionConflict, withIdempotency, withOrgTx, writeAudit, type Principal, type EventKind } from '../kernel';
import { accessPrincipal, addRecipients, author, clock, present, requireAuthor, rootRow, state, validateRecipients } from './shared';
import { flagsInput, parse, replyInput, rootInput, type PostRootInput, type PostReplyInput, type UpdateRootFlagsInput } from './validation';

export async function postRoot(principal: Principal, input: PostRootInput) {
  const data = parse(rootInput, input);
  return withOrgTx(principal, async (tx, ctx) => {
    requireAuthor(ctx);
    return withIdempotency(tx, ctx, 'message.postRoot', data.idempotencyKey, data, async () => {
      await assertProjectAccess(tx, accessPrincipal(ctx), data.projectId, 'write');
      await validateRecipients(tx, ctx, data.recipients);
      const provenance = await author(tx, ctx);
      const [row] = await tx.insert(messages).values({
        id: newId(), orgId: ctx.orgId, projectId: data.projectId, title: data.title, body: data.body,
        category: data.category, urgent: data.urgent, pinned: data.pinned, status: 'active', version: 1,
        lastActivityAt: clock, ...provenance,
      }).returning();
      if (!row) throw new DomainError('unavailable');
      await addRecipients(tx, ctx, row.id, data.recipients);
      await appendEvents(tx, ctx.orgId, [{ kind: 'message.created', projectId: row.projectId, messageId: row.id, rootId: row.id, payload: state(row) }]);
      await writeAudit(tx, ctx, { action: 'message.created', entityType: 'message', entityId: row.id, after: { ...state(row), category: row.category, recipients: data.recipients } });
      return { ...present(row, []), recipients: data.recipients };
    });
  });
}
export async function postReply(principal: Principal, input: PostReplyInput) {
  const data = parse(replyInput, input);
  return withOrgTx(principal, async (tx, ctx) => {
    requireAuthor(ctx);
    return withIdempotency(tx, ctx, 'message.postReply', data.idempotencyKey, data, async () => {
      const { row: root } = await rootRow(tx, ctx, data.rootId, 'write', true);
      if (root.status === 'archived') throw new DomainError('thread_archived');
      await validateRecipients(tx, ctx, data.recipients);
      const provenance = await author(tx, ctx);
      const [row] = await tx.insert(messages).values({
        id: newId(), orgId: ctx.orgId, projectId: root.projectId, rootId: root.id, body: data.body,
        createdAt: clock, updatedAt: clock, ...provenance,
      }).returning();
      if (!row) throw new DomainError('unavailable');
      await addRecipients(tx, ctx, row.id, data.recipients);
      await tx.update(messages).set({ lastActivityAt: clock, updatedAt: clock }).where(and(eq(messages.orgId, ctx.orgId), eq(messages.id, root.id)));
      await appendEvents(tx, ctx.orgId, [{ kind: 'message.replied', projectId: root.projectId, messageId: row.id, rootId: root.id }]);
      await writeAudit(tx, ctx, { action: 'message.replied', entityType: 'message', entityId: row.id, after: { rootId: root.id, recipients: data.recipients } });
      return { ...present(row, []), recipients: data.recipients };
    });
  });
}
export async function updateRootFlags(principal: Principal, input: UpdateRootFlagsInput) {
  const data = parse(flagsInput, input);
  return withOrgTx(principal, async (tx, ctx) => {
    requireAuthor(ctx);
    return withIdempotency(tx, ctx, 'message.updateRootFlags', data.idempotencyKey, data, async () => {
      const { row } = await rootRow(tx, ctx, data.rootId, 'write', true);
      if (row.version !== data.expectedVersion) throw versionConflict(row.version!, state(row));
      const before = state(row);
      const after = { status: data.status ?? row.status, urgent: data.urgent ?? row.urgent, pinned: data.pinned ?? row.pinned, version: row.version! + 1 };
      const flagChanged = after.urgent !== before.urgent || after.pinned !== before.pinned;
      const lifecycleChanged = after.status !== before.status;
      if (!flagChanged && !lifecycleChanged) return { id: row.id, ...before };
      await tx.update(messages).set({ ...after, updatedAt: clock, lastActivityAt: clock }).where(and(eq(messages.orgId, ctx.orgId), eq(messages.id, row.id)));
      const kinds: EventKind[] = [];
      if (flagChanged) kinds.push('message.flag_changed');
      if (lifecycleChanged) kinds.push(after.status === 'archived' ? 'message.archived' : 'message.restored');
      await appendEvents(tx, ctx.orgId, kinds.map((kind) => ({ kind, projectId: row.projectId, messageId: row.id, rootId: row.id, payload: { before, after } })));
      await writeAudit(tx, ctx, { action: 'message.updated', entityType: 'message', entityId: row.id, before, after });
      return { id: row.id, ...after };
    });
  });
}
