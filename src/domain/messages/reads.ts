import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { DbTx } from '../../db/client';
import { messages } from '../../db/schema/messages';
import { auditRecords } from '../../db/schema/ops';
import { projects } from '../../db/schema/projects';
import { accessibleProjectIds, assertProjectAccess, DomainError, withOrgTx, type Principal, type TxContext } from '../kernel';
import { binding, decodeCursor, encodeCursor } from './cursor';
import { accessPrincipal, present, recipientsFor, rootRow } from './shared';
import { listInput, parse, threadInput, type GetThreadInput, type ListThreadsInput } from './validation';

export const EXCERPT_CHARACTERS = 512;
function scope(ctx: TxContext, ids: string[], filter: unknown) {
  return binding({ v: 1, org: ctx.orgId, actor: ctx.principal.kind === 'human' ? ctx.principal.userId : ctx.principal.kind === 'agent' ? ctx.principal.tokenId : 'system', ids: [...ids].sort(), filter });
}
export function listThreads(principal: Principal, input: ListThreadsInput) {
  return withOrgTx(principal, (tx, ctx) => listThreadsInTx(tx, ctx, input));
}
export async function listThreadsInTx(tx: DbTx, ctx: TxContext, input: ListThreadsInput) {
  const data = parse(listInput, input);
  const allowed = await accessibleProjectIds(tx, accessPrincipal(ctx), { includeArchived: true });
  for (const id of data.projectIds) {
    if (!allowed.includes(id)) throw new DomainError('forbidden_or_not_found');
    await assertProjectAccess(tx, accessPrincipal(ctx), id, 'read');
  }
  const { cursor, limit, ...filters } = data;
  const cursorScope = scope(ctx, allowed, { type: 'threads', ...filters });
  const position = decodeCursor(cursor, cursorScope);
  const where: SQL[] = [eq(messages.orgId, ctx.orgId), inArray(messages.projectId, data.projectIds), isNull(messages.rootId)];
  if (data.status !== 'all') where.push(eq(messages.status, data.status));
  if (data.category !== undefined) where.push(eq(messages.category, data.category));
  if (data.urgent !== undefined) where.push(eq(messages.urgent, data.urgent));
  if (data.pinned !== undefined) where.push(eq(messages.pinned, data.pinned));
  if (data.authorAgentId !== undefined) where.push(eq(messages.authorAgentId, data.authorAgentId));
  if (data.authorUserId !== undefined) where.push(eq(messages.authorUserId, data.authorUserId));
  if (data.recipientAgentId !== undefined) where.push(sql`exists (
    select 1 from message_recipients mr join messages addressed on addressed.org_id = mr.org_id and addressed.id = mr.message_id
    where mr.org_id = ${ctx.orgId} and addressed.project_id = ${messages.projectId}
    and (addressed.id = ${messages.id} or addressed.root_id = ${messages.id}) and mr.agent_id = ${data.recipientAgentId}::uuid
  )`);
  if (data.query) where.push(sql`exists (
    select 1 from messages matched where matched.org_id = ${ctx.orgId} and matched.project_id = ${messages.projectId}
    and (matched.id = ${messages.id} or matched.root_id = ${messages.id})
    and matched.search_vector @@ websearch_to_tsquery('english', ${data.query})
  )`);
  // Counts use exactly the authorized root predicate, before the keyset boundary.
  const [count] = await tx.select({ totalCount: sql<number>`count(*)::int` }).from(messages).where(and(...where));
  const orderColumn = data.sort === 'activity' ? messages.lastActivityAt : messages.createdAt;
  const ascending = data.sort === 'oldest';
  if (position) where.push(ascending
    ? sql`(${orderColumn}, ${messages.id}) > (${position.at}::timestamptz, ${position.id}::uuid)`
    : sql`(${orderColumn}, ${messages.id}) < (${position.at}::timestamptz, ${position.id}::uuid)`);
  // Format timestamps in SQL for the cursor: JS Dates would drop PG microseconds.
  const rows = await tx.select({
    id: messages.id, projectId: messages.projectId, projectSlug: projects.slug, projectName: projects.name,
    title: messages.title, category: messages.category, status: messages.status, urgent: messages.urgent,
    pinned: messages.pinned, version: messages.version, authorKind: messages.authorKind,
    authorUserId: messages.authorUserId, authorAgentId: messages.authorAgentId, authorDisplayName: messages.authorDisplayName,
    createdAt: messages.createdAt, lastActivityAt: messages.lastActivityAt,
    excerpt: sql<string>`left(${messages.body}, ${EXCERPT_CHARACTERS})`,
    bodyTruncated: sql<boolean>`char_length(${messages.body}) > ${EXCERPT_CHARACTERS}`,
    positionAt: sql<string>`to_char(${orderColumn} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    replyCount: sql<number>`(select count(*)::int from messages r where r.org_id = ${ctx.orgId} and r.project_id = ${messages.projectId} and r.root_id = ${messages.id})`,
  }).from(messages).innerJoin(projects, and(eq(projects.orgId, messages.orgId), eq(projects.id, messages.projectId)))
    .where(and(...where)).orderBy(ascending ? asc(orderColumn) : desc(orderColumn), ascending ? asc(messages.id) : desc(messages.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const recipients = await recipientsFor(tx, ctx, page.map((row) => row.id));
  const items = await Promise.all(page.map(async (row) => {
    const matches = data.query ? await tx.select({
      id: messages.id, rootId: messages.rootId, excerpt: sql<string>`left(${messages.body}, ${EXCERPT_CHARACTERS})`,
      bodyTruncated: sql<boolean>`char_length(${messages.body}) > ${EXCERPT_CHARACTERS}`,
    }).from(messages).where(and(eq(messages.orgId, ctx.orgId), eq(messages.projectId, row.projectId),
      sql`(${messages.id} = ${row.id}::uuid or ${messages.rootId} = ${row.id}::uuid)`,
      sql`${messages.searchVector} @@ websearch_to_tsquery('english', ${data.query})`))
      .orderBy(asc(messages.createdAt), asc(messages.id)).limit(21) : [];
    const { positionAt, ...preview } = row;
    void positionAt;
    return { ...preview, createdAt: row.createdAt.toISOString(), lastActivityAt: row.lastActivityAt!.toISOString(),
      recipients: recipients.get(row.id) ?? [], matches: matches.slice(0, 20), matchesTruncated: matches.length > 20 };
  }));
  const last = page.at(-1);
  return { items, totalCount: count?.totalCount ?? 0,
    nextCursor: rows.length > limit && last ? encodeCursor(cursorScope, { at: last.positionAt, id: last.id }) : null };
}
export function getThread(principal: Principal, input: GetThreadInput) {
  return withOrgTx(principal, (tx, ctx) => getThreadInTx(tx, ctx, input));
}
export async function getThreadInTx(tx: DbTx, ctx: TxContext, input: GetThreadInput) {
  const data = parse(threadInput, input);
  const { row, project } = await rootRow(tx, ctx, data.rootId, 'read');
  const allowed = await accessibleProjectIds(tx, accessPrincipal(ctx), { includeArchived: true });
  const cursorScope = scope(ctx, allowed, { type: 'replies', rootId: row.id });
  const position = decodeCursor(data.replyCursor, cursorScope);
  const where = [eq(messages.orgId, ctx.orgId), eq(messages.projectId, row.projectId), eq(messages.rootId, row.id)];
  if (position) where.push(sql`(${messages.createdAt}, ${messages.id}) > (${position.at}::timestamptz, ${position.id}::uuid)`);
  const replies = await tx.select({ row: messages,
    positionAt: sql<string>`to_char(${messages.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  }).from(messages).where(and(...where)).orderBy(asc(messages.createdAt), asc(messages.id)).limit(data.replyLimit + 1);
  const page = replies.slice(0, data.replyLimit);
  const recipients = await recipientsFor(tx, ctx, [row.id, ...page.map((r) => r.row.id)]);
  const [count] = await tx.select({ totalCount: sql<number>`count(*)::int` }).from(messages)
    .where(and(eq(messages.orgId, ctx.orgId), eq(messages.projectId, row.projectId), eq(messages.rootId, row.id)));
  const last = page.at(-1);
  return { root: present(row, recipients.get(row.id) ?? []), project: { id: project.id, slug: project.slug, name: project.name },
    replies: page.map((r) => present(r.row, recipients.get(r.row.id) ?? [])), replyCount: count?.totalCount ?? 0,
    nextReplyCursor: replies.length > data.replyLimit && last ? encodeCursor(cursorScope, { at: last.positionAt, id: last.row.id }) : null };
}
export function getThreadHistory(principal: Principal, rootId: string) {
  return withOrgTx(principal, (tx, ctx) => getThreadHistoryInTx(tx, ctx, rootId));
}
export async function getThreadHistoryInTx(tx: DbTx, ctx: TxContext, rootId: string) {
  await rootRow(tx, ctx, rootId, 'read');
  const rows = await tx.select().from(auditRecords).where(and(
    eq(auditRecords.orgId, ctx.orgId), eq(auditRecords.entityType, 'message'), eq(auditRecords.entityId, rootId), eq(auditRecords.action, 'message.updated'),
  )).orderBy(asc(auditRecords.createdAt), asc(auditRecords.id));
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}
