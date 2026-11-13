import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AppDatabase, DbTx } from '../../db/client';
import { getDb } from '../../db/client';
import { user } from '../../db/schema/auth';
import { messages } from '../../db/schema/messages';
import { getAnnouncementsInTx, type AnnouncementPair } from '../announcements';
import { listAgentsInTx } from '../credentials';
import { DomainError, withOrgTx, type Principal, type TxContext } from '../kernel';
import { listProjectsInTx } from '../projects';

export type OrgHomeProject = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  activeRootCount: number;
  urgentRootCount: number;
  lastActivityAt: string | null;
};

export type OrgHomeAgent = {
  id: string;
  name: string;
  lastSeenAt: string | null;
};

export type OrgHome = {
  projects: OrgHomeProject[];
  agents: OrgHomeAgent[];
  announcements: AnnouncementPair;
};

function requireOwner(principal: Principal): asserts principal is Extract<Principal, { kind: 'human' }> {
  if (principal.kind !== 'human') throw new DomainError('capability_denied');
}

/** Display name of the signed-in owner. Org id comes from the principal. */
export async function getOwnerProfile(principal: Principal, database?: AppDatabase): Promise<{ name: string }> {
  requireOwner(principal);
  return withOrgTx(principal, async (tx, ctx) => {
    const userId = ctx.principal.kind === 'human' ? ctx.principal.userId : '';
    const [row] = await tx.select({ name: user.name }).from(user).where(eq(user.id, userId));
    if (!row?.name) throw new DomainError('forbidden_or_not_found');
    return { name: row.name };
  }, database ?? getDb());
}

/**
 * Accessible active projects, root counts, agent last-seen, and both
 * announcement scopes. One transaction and a fixed query count: counts are
 * grouped, not loaded once per project.
 */
export async function getOrgHome(principal: Principal, database?: AppDatabase): Promise<OrgHome> {
  requireOwner(principal);
  return withOrgTx(principal, (tx, ctx) => getOrgHomeInTx(tx, ctx), database ?? getDb());
}

export async function getOrgHomeInTx(tx: DbTx, ctx: TxContext): Promise<OrgHome> {
  requireOwner(ctx.principal);
  // A transaction client cannot run statements concurrently.
  const projects = await projectSummaries(tx, ctx);
  // Agent roster is owner-only (D-039); members still see projects and announcements.
  const agents = ctx.role === 'owner' ? await listAgentsInTx(tx, ctx) : [];
  const announcements = await getAnnouncementsInTx(tx, ctx);
  return {
    projects,
    agents: agents.map((agent) => ({ id: agent.id, name: agent.name, lastSeenAt: agent.lastSeenAt })),
    announcements,
  };
}

async function projectSummaries(tx: DbTx, ctx: TxContext): Promise<OrgHomeProject[]> {
  const visible = await listProjectsInTx(tx, ctx);
  const ids = visible.map((project) => project.id);
  const counts = new Map<string, { activeRootCount: number; urgentRootCount: number; lastActivityAt: string | null }>();
  if (ids.length > 0) {
    const rows = await tx.select({
      projectId: messages.projectId,
      activeRootCount: sql<number>`count(*) filter (where ${messages.status} = 'active')::int`,
      urgentRootCount: sql<number>`count(*) filter (where ${messages.status} = 'active' and ${messages.urgent} is true)::int`,
      lastActivityAt: sql<Date | string | null>`max(${messages.lastActivityAt}) filter (where ${messages.status} = 'active')`,
    }).from(messages).where(and(
      eq(messages.orgId, ctx.orgId),
      isNull(messages.rootId),
      inArray(messages.projectId, ids),
    )).groupBy(messages.projectId);
    for (const row of rows) {
      counts.set(row.projectId, {
        activeRootCount: asCount(row.activeRootCount),
        urgentRootCount: asCount(row.urgentRootCount),
        lastActivityAt: asIso(row.lastActivityAt),
      });
    }
  }
  return visible.map((project) => {
    const count = counts.get(project.id);
    return {
      id: project.id,
      slug: project.slug,
      name: project.name,
      description: project.description,
      activeRootCount: count?.activeRootCount ?? 0,
      urgentRootCount: count?.urgentRootCount ?? 0,
      lastActivityAt: count?.lastActivityAt ?? null,
    };
  });
}

function asCount(value: unknown): number {
  const count = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(count) && count >= 0 ? count : 0;
}

function asIso(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
