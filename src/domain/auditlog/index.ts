import { and, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
import type { AppDatabase, DbTx } from '../../db/client';
import { getDb } from '../../db/client';
import { user } from '../../db/schema/auth';
import { agentTokens, agents } from '../../db/schema/identity';
import { auditRecords } from '../../db/schema/ops';
import { DomainError, withOrgTx, type Principal, type TxContext } from '../kernel';
import { auditScope, decodeAuditCursor, encodeAuditCursor } from './cursor';
import { actorLabel, summarizeChange } from './summary';

export { actorLabel, summarizeChange } from './summary';

export const DEFAULT_AUDIT_LIMIT = 50;
export const MAX_AUDIT_LIMIT = 100;
const SESSION_SEEN = 'agent.session_seen';

export type ListAuditLogInput = {
  cursor?: string;
  limit?: number;
  includeSessionSeen?: boolean;
};

export type AuditLogEntry = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  actorKind: 'human' | 'agent' | 'system';
  actorName: string | null;
  tokenPrefix: string | null;
  actorLabel: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  summary: string;
};

export type AuditLogPage = {
  items: AuditLogEntry[];
  nextCursor: string | null;
};

type Parsed = { cursor?: string; limit: number; includeSessionSeen: boolean };

function requireOwner(principal: Principal): asserts principal is Extract<Principal, { kind: 'human' }> {
  if (principal.kind !== 'human') throw new DomainError('capability_denied');
}

export async function listAuditLog(principal: Principal, input: ListAuditLogInput = {}, database?: AppDatabase): Promise<AuditLogPage> {
  requireOwner(principal);
  const parsed = parseInput(input);
  return withOrgTx(principal, (tx, ctx) => listAuditLogInTx(tx, ctx, parsed), database ?? getDb());
}

export async function listAuditLogInTx(tx: DbTx, ctx: TxContext, input: Parsed): Promise<AuditLogPage> {
  requireOwner(ctx.principal);
  const scope = auditScope(ctx.orgId, input.includeSessionSeen);
  const position = decodeAuditCursor(input.cursor, scope);
  const filters: SQL[] = [eq(auditRecords.orgId, ctx.orgId)];
  if (!input.includeSessionSeen) filters.push(ne(auditRecords.action, SESSION_SEEN));
  if (position) filters.push(sql`(${auditRecords.createdAt}, ${auditRecords.id}) < (${position.at}::timestamptz, ${position.id}::uuid)`);
  const rows = await tx.select({
    id: auditRecords.id,
    action: auditRecords.action,
    entityType: auditRecords.entityType,
    entityId: auditRecords.entityId,
    before: auditRecords.before,
    after: auditRecords.after,
    createdAt: auditRecords.createdAt,
    positionAt: sql<string>`to_char(${auditRecords.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    actorKind: auditRecords.actorKind,
    userName: user.name,
    agentName: agents.name,
    tokenPrefix: agentTokens.prefix,
  }).from(auditRecords)
    .leftJoin(user, eq(user.id, auditRecords.userId))
    .leftJoin(agents, and(eq(agents.orgId, auditRecords.orgId), eq(agents.id, auditRecords.agentId)))
    .leftJoin(agentTokens, and(eq(agentTokens.orgId, auditRecords.orgId), eq(agentTokens.id, auditRecords.tokenId)))
    .where(and(...filters))
    .orderBy(desc(auditRecords.createdAt), desc(auditRecords.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    items: page.map((row) => {
      const actorKind = row.actorKind === 'human' || row.actorKind === 'agent' || row.actorKind === 'system' ? row.actorKind : 'system';
      const actorName = actorKind === 'human' ? row.userName : actorKind === 'agent' ? row.agentName : null;
      const before = row.before ?? null;
      const after = row.after ?? null;
      return {
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        createdAt: row.createdAt.toISOString(),
        actorKind,
        actorName,
        tokenPrefix: row.tokenPrefix,
        actorLabel: actorLabel(actorKind, actorName, row.tokenPrefix),
        before,
        after,
        summary: summarizeChange(before, after),
      };
    }),
    nextCursor: rows.length > input.limit && last ? encodeAuditCursor(scope, { at: last.positionAt, id: last.id }) : null,
  };
}

function parseInput(input: ListAuditLogInput): Parsed {
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length < 1 || input.cursor.length > 4096)) {
    throw new DomainError('validation_failed', { field: 'cursor' });
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_AUDIT_LIMIT)) {
    throw new DomainError('validation_failed', { field: 'limit' });
  }
  if (input.includeSessionSeen !== undefined && typeof input.includeSessionSeen !== 'boolean') {
    throw new DomainError('validation_failed', { field: 'includeSessionSeen' });
  }
  return {
    cursor: input.cursor,
    limit: input.limit ?? DEFAULT_AUDIT_LIMIT,
    includeSessionSeen: input.includeSessionSeen ?? false,
  };
}
