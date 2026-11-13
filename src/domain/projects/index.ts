import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DbTx } from '../../db/client';
import { agentProjectDefaults, projects, tokenProjectGrants } from '../../db/schema/projects';
import { accessibleProjectIds, appendEvents, assertProjectAccess, DomainError, isUuid, newId, requireTxOwner, withIdempotency, withOrgTx, writeAudit } from '../kernel';
import type { Principal, TxContext } from '../kernel';

export function requireOwner(principal: Principal): asserts principal is Extract<Principal, { kind: 'human' }> {
  if (principal.kind !== 'human') throw new DomainError('capability_denied');
}
export function requireId(id: string): void {
  if (!isUuid(id)) throw new DomainError('forbidden_or_not_found');
}
export function textField(value: string, field: string, max: number): void {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max) throw new DomainError('validation_failed', { field });
}
function descriptionField(value: string | null | undefined): void {
  if (value != null && (typeof value !== 'string' || Buffer.byteLength(value) > 8192)) throw new DomainError('validation_failed', { field: 'description' });
}
export async function listProjectsInTx(tx: DbTx, ctx: TxContext, { includeArchived = false }: { includeArchived?: boolean } = {}) {
  const ids = await accessibleProjectIds(tx, ctx.principal, { includeArchived });
  if (!ids.length) return [];
  const rows = await tx.select().from(projects).where(and(eq(projects.orgId, ctx.orgId), inArray(projects.id, ids))).orderBy(asc(projects.slug));
  return rows.map(serializeProject);
}
export function listProjects(principal: Principal, options: { includeArchived?: boolean } = {}) {
  return withOrgTx(principal, (tx, ctx) => listProjectsInTx(tx, ctx, options));
}
export async function getProjectBySlugInTx(tx: DbTx, ctx: TxContext, slug: string) {
  const [row] = await tx.select({ id: projects.id, visibility: projects.visibility }).from(projects).where(and(eq(projects.orgId, ctx.orgId), eq(projects.slug, slug)));
  if (!row) throw new DomainError('forbidden_or_not_found');
  const project = await assertProjectAccess(tx, ctx.principal, row.id, 'read');
  return { ...project, visibility: row.visibility === 'public' ? 'public' as const : 'private' as const };
}
export function getProjectBySlug(principal: Principal, slug: string) {
  return withOrgTx(principal, (tx, ctx) => getProjectBySlugInTx(tx, ctx, slug));
}
export type CreateProjectInput = { name: string; slug: string; description?: string; idempotencyKey: string };
export function createProject(principal: Principal, input: CreateProjectInput) {
  return withOrgTx(principal, async (tx, ctx) => {
    if (principal.kind === 'system') throw new DomainError('capability_denied');
    if (!ctx.canCreateProjects) throw new DomainError('capability_denied');
    if (principal.kind === 'agent' && (!principal.agentId || !principal.sessionId)) throw new DomainError('unauthenticated');
    textField(input.name, 'name', 200);
    if (typeof input.slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.slug)) throw new DomainError('validation_failed', { field: 'slug' });
    descriptionField(input.description);
    return withIdempotency(tx, ctx, 'project.create', input.idempotencyKey, {
      name: input.name, slug: input.slug, description: input.description ?? null,
    }, async () => {
      const [row] = await tx.insert(projects).values({
        id: newId(), orgId: ctx.orgId, name: input.name, slug: input.slug, description: input.description ?? null, status: 'active',
        createdByKind: principal.kind,
        createdByUserId: principal.kind === 'human' ? principal.userId : null,
        createdByTokenId: principal.kind === 'agent' ? principal.tokenId : null,
        createdByAgentId: principal.kind === 'agent' ? principal.agentId : null,
      }).onConflictDoNothing({ target: [projects.orgId, projects.slug] }).returning();
      if (!row) throw new DomainError('validation_failed', { field: 'slug' });
      if (principal.kind === 'agent') {
        if (ctx.projectIds !== 'all') await tx.insert(tokenProjectGrants).values({ orgId: ctx.orgId, tokenId: principal.tokenId, projectId: row.id, source: 'agent_create' });
        await tx.insert(agentProjectDefaults).values({ orgId: ctx.orgId, agentId: principal.agentId!, projectId: row.id });
      }
      await appendEvents(tx, ctx.orgId, [{ kind: 'project.created', projectId: row.id, payload: { slug: row.slug, name: row.name } }]);
      await writeAudit(tx, ctx, { action: 'project.create', entityType: 'project', entityId: row.id, after: { slug: row.slug, name: row.name, status: row.status } });
      return serializeProject(row);
    });
  });
}
function serializeProject(row: typeof projects.$inferSelect) {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
async function changeProject(principal: Principal, projectId: string, input: { name?: string; description?: string | null; status?: 'active' | 'archived' }, action: 'updated' | 'archived' | 'restored') {
  requireOwner(principal); requireId(projectId);
  if (input.name !== undefined) textField(input.name, 'name', 200);
  descriptionField(input.description);
  return withOrgTx(principal, async (tx, ctx) => {
    requireTxOwner(ctx);
    const [before] = await tx.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.orgId, ctx.orgId))).for('update');
    if (!before) throw new DomainError('forbidden_or_not_found');
    const [after] = await tx.update(projects).set({ ...input, updatedAt: new Date() }).where(eq(projects.id, projectId)).returning();
    await appendEvents(tx, ctx.orgId, [{ kind: `project.${action}`, projectId, payload: { status: after!.status } }]);
    await writeAudit(tx, ctx, { action: `project.${action}`, entityType: 'project', entityId: projectId,
      before: { name: before.name, description: before.description, status: before.status },
      after: { name: after!.name, description: after!.description, status: after!.status } });
    return serializeProject(after!);
  });
}
export function updateProject(principal: Principal, projectId: string, input: { name?: string; description?: string | null }) {
  // Copy only supported fields: callers cannot smuggle lifecycle or provenance updates.
  return changeProject(principal, projectId, { name: input.name, description: input.description }, 'updated');
}
export function archiveProject(principal: Principal, projectId: string) { return changeProject(principal, projectId, { status: 'archived' }, 'archived'); }
export function restoreProject(principal: Principal, projectId: string) { return changeProject(principal, projectId, { status: 'active' }, 'restored'); }

/** Owner only. Agents receive capability_denied. Audited, and emits access.changed so clients resync. */
export function setProjectVisibility(principal: Principal, projectId: string, visibility: 'private' | 'public') {
  requireOwner(principal);
  requireId(projectId);
  if (visibility !== 'private' && visibility !== 'public') throw new DomainError('validation_failed', { field: 'visibility' });
  return withOrgTx(principal, async (tx, ctx) => {
    requireTxOwner(ctx);
    const [before] = await tx.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.orgId, ctx.orgId))).for('update');
    if (!before) throw new DomainError('forbidden_or_not_found');
    const [after] = await tx.update(projects).set({ visibility, updatedAt: new Date() }).where(and(eq(projects.id, projectId), eq(projects.orgId, ctx.orgId))).returning();
    if (!after) throw new DomainError('forbidden_or_not_found');
    await appendEvents(tx, ctx.orgId, [{ kind: 'access.changed', projectId, payload: { visibility } }]);
    await writeAudit(tx, ctx, { action: 'project.set_visibility', entityType: 'project', entityId: projectId,
      before: { visibility: before.visibility }, after: { visibility: after.visibility } });
    return serializeProject(after);
  });
}
