import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { getDb, type AppDatabase } from '../../db/client';
import { messages } from '../../db/schema/messages';
import { organizations } from '../../db/schema/org';
import { DomainError, invalidCursor, isUuid, withPublicReadTx, type PublicProjectGate } from '../kernel';
import { loadEnv } from '../../env';

const organizationSlugPattern = /^[a-z0-9][a-z0-9-]{1,39}$/;
const projectSlugPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const excerptCharacters = 512;

export type PublicAuthor = { displayName: string; kind: 'human' | 'agent' };

export type PublicThreadSummary = {
  id: string;
  title: string;
  excerpt: string;
  bodyTruncated: boolean;
  author: PublicAuthor;
  category: string;
  urgent: boolean;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  replyCount: number;
};

export type PublicProjectCard = { slug: string; name: string; description: string | null };

export type PublicThreadPage = {
  project: PublicProjectCard;
  items: PublicThreadSummary[];
  nextCursor: string | null;
};

export type PublicReply = {
  id: string;
  body: string;
  author: PublicAuthor;
  createdAt: string;
};

export type PublicThread = {
  project: PublicProjectCard;
  root: {
    id: string;
    title: string;
    body: string;
    author: PublicAuthor;
    category: string;
    urgent: boolean;
    pinned: boolean;
    createdAt: string;
    updatedAt: string;
    lastActivityAt: string;
  };
  replies: PublicReply[];
  replyCount: number;
  nextReplyCursor: string | null;
};

type Sort = 'activity' | 'newest';

function missing(): never {
  throw new DomainError('forbidden_or_not_found');
}

function card(project: PublicProjectGate): PublicProjectCard {
  return { slug: project.slug, name: project.name, description: project.description };
}

function author(kind: string, displayName: string): PublicAuthor {
  if (kind !== 'human' && kind !== 'agent') missing();
  return { kind, displayName };
}

function activeRoots(orgId: string, projectId: string): SQL[] {
  return [
    eq(messages.orgId, orgId),
    eq(messages.projectId, projectId),
    isNull(messages.rootId),
    eq(messages.status, 'active'),
  ];
}

async function activeOrganization(slug: string, database: AppDatabase): Promise<string> {
  if (!organizationSlugPattern.test(slug)) missing();
  const [org] = await database.select({ id: organizations.id, status: organizations.status })
    .from(organizations).where(eq(organizations.slug, slug)).limit(1);
  if (!org || org.status !== 'active') missing();
  return org.id;
}

function mac(value: string): Buffer {
  return createHmac('sha256', loadEnv().CURSOR_HMAC_SECRET).update(value).digest();
}

function encodeCursor(scope: string, position: { at: string; id: string }): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, scope, ...position })).toString('base64url');
  return `${payload}.${mac(payload).toString('base64url')}`;
}

function decodeCursor(cursor: string | undefined, scope: string): { at: string; id: string } | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parts = cursor.split('.');
    if (parts.length !== 2) throw new Error('shape');
    const [payload, signature] = parts as [string, string];
    const supplied = Buffer.from(signature, 'base64url');
    const expected = mac(payload);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('mac');
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { v?: unknown; scope?: unknown; at?: unknown; id?: unknown };
    if (value.v !== 1 || value.scope !== scope || typeof value.id !== 'string' || !isUuid(value.id)
      || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) throw new Error('payload');
    return { at: value.at, id: value.id };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw invalidCursor('Restart this list without a cursor.');
  }
}

function sortOf(value: string | undefined): Sort {
  if (value === undefined || value === 'activity') return 'activity';
  if (value === 'newest') return 'newest';
  throw new DomainError('validation_failed', { field: 'sort' });
}

function queryOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.includes('\0') || value.length > 1000) throw new DomainError('validation_failed', { field: 'query' });
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function limitOf(value: number | undefined): number {
  if (value === undefined) return 20;
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new DomainError('validation_failed', { field: 'limit' });
  return value;
}

export async function listPublicThreads(input: {
  orgSlug: string;
  projectSlug: string;
  sort?: string;
  query?: string;
  cursor?: string;
  limit?: number;
}, database: AppDatabase = getDb()): Promise<PublicThreadPage> {
  if (!projectSlugPattern.test(input.projectSlug)) missing();
  const sort = sortOf(input.sort);
  const query = queryOf(input.query);
  const limit = limitOf(input.limit);
  const orgId = await activeOrganization(input.orgSlug, database);
  return withPublicReadTx(orgId, input.projectSlug, async (tx, project) => {
    const where = activeRoots(orgId, project.id);
    if (query) {
      where.push(sql`exists (
        select 1 from messages matched
        where matched.org_id = ${orgId}
          and matched.project_id = ${project.id}
          and (matched.id = ${messages.id} or matched.root_id = ${messages.id})
          and matched.search_vector @@ websearch_to_tsquery('english', ${query})
      )`);
    }
    const scope = JSON.stringify({ v: 1, kind: 'public-threads', orgId, projectId: project.id, sort, query: query ?? '' });
    const position = decodeCursor(input.cursor, scope);
    const orderColumn = sort === 'activity' ? messages.lastActivityAt : messages.createdAt;
    if (position) where.push(sql`(${orderColumn}, ${messages.id}) < (${position.at}::timestamptz, ${position.id}::uuid)`);
    const built = tx.select({
      id: messages.id,
      title: messages.title,
      category: messages.category,
      urgent: messages.urgent,
      pinned: messages.pinned,
      authorKind: messages.authorKind,
      authorDisplayName: messages.authorDisplayName,
      createdAt: messages.createdAt,
      updatedAt: messages.updatedAt,
      lastActivityAt: messages.lastActivityAt,
      excerpt: sql<string>`left(${messages.body}, ${excerptCharacters})`,
      bodyTruncated: sql<boolean>`char_length(${messages.body}) > ${excerptCharacters}`,
      positionAt: sql<string>`to_char(${orderColumn} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      replyCount: sql<number>`(select count(*)::int from messages r where r.org_id = ${orgId} and r.project_id = ${project.id} and r.root_id = messages.id)`,
    }).from(messages).where(and(...where)).orderBy(desc(orderColumn), desc(messages.id)).limit(limit + 1);
    const rows = await built;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      project: card(project),
      items: page.map((row) => ({
        id: row.id,
        title: row.title ?? 'Untitled',
        excerpt: row.excerpt,
        bodyTruncated: row.bodyTruncated,
        author: author(row.authorKind, row.authorDisplayName),
        category: row.category ?? 'note',
        urgent: row.urgent === true,
        pinned: row.pinned === true,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        lastActivityAt: row.lastActivityAt?.toISOString() ?? row.createdAt.toISOString(),
        replyCount: row.replyCount,
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(scope, { at: last.positionAt, id: last.id }) : null,
    };
  }, database);
}

export async function getPublicThread(input: {
  orgSlug: string;
  projectSlug: string;
  rootId: string;
  replyCursor?: string;
  replyLimit?: number;
}, database: AppDatabase = getDb()): Promise<PublicThread> {
  if (!projectSlugPattern.test(input.projectSlug) || !isUuid(input.rootId)) missing();
  const replyLimit = limitOf(input.replyLimit);
  const orgId = await activeOrganization(input.orgSlug, database);
  return withPublicReadTx(orgId, input.projectSlug, async (tx, project) => {
    const [root] = await tx.select({
      id: messages.id,
      title: messages.title,
      body: messages.body,
      category: messages.category,
      urgent: messages.urgent,
      pinned: messages.pinned,
      authorKind: messages.authorKind,
      authorDisplayName: messages.authorDisplayName,
      createdAt: messages.createdAt,
      updatedAt: messages.updatedAt,
      lastActivityAt: messages.lastActivityAt,
    }).from(messages).where(and(...activeRoots(orgId, project.id), eq(messages.id, input.rootId))).limit(1);
    if (!root || root.title === null) missing();
    const scope = JSON.stringify({ v: 1, kind: 'public-replies', orgId, projectId: project.id, rootId: root.id });
    const position = decodeCursor(input.replyCursor, scope);
    const replyWhere = [
      eq(messages.orgId, orgId),
      eq(messages.projectId, project.id),
      eq(messages.rootId, root.id),
    ];
    if (position) replyWhere.push(sql`(${messages.createdAt}, ${messages.id}) > (${position.at}::timestamptz, ${position.id}::uuid)`);
    const replies = await tx.select({
      id: messages.id,
      body: messages.body,
      authorKind: messages.authorKind,
      authorDisplayName: messages.authorDisplayName,
      createdAt: messages.createdAt,
      positionAt: sql<string>`to_char(${messages.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    }).from(messages).where(and(...replyWhere)).orderBy(asc(messages.createdAt), asc(messages.id)).limit(replyLimit + 1);
    const page = replies.slice(0, replyLimit);
    const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(messages).where(and(
      eq(messages.orgId, orgId), eq(messages.projectId, project.id), eq(messages.rootId, root.id),
    ));
    const last = page.at(-1);
    return {
      project: card(project),
      root: {
        id: root.id,
        title: root.title,
        body: root.body,
        author: author(root.authorKind, root.authorDisplayName),
        category: root.category ?? 'note',
        urgent: root.urgent === true,
        pinned: root.pinned === true,
        createdAt: root.createdAt.toISOString(),
        updatedAt: root.updatedAt.toISOString(),
        lastActivityAt: root.lastActivityAt?.toISOString() ?? root.createdAt.toISOString(),
      },
      replies: page.map((reply) => ({
        id: reply.id,
        body: reply.body,
        author: author(reply.authorKind, reply.authorDisplayName),
        createdAt: reply.createdAt.toISOString(),
      })),
      replyCount: count?.total ?? 0,
      nextReplyCursor: replies.length > replyLimit && last ? encodeCursor(scope, { at: last.positionAt, id: last.id }) : null,
    };
  }, database);
}
