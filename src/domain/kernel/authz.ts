import { and, eq } from 'drizzle-orm';
import type { DbTx } from '../../db/client';
import { tokenProjectGrants } from '../../db/schema/projects';
import { projects } from '../../db/schema/projects';
import { DomainError } from './errors';
import type { Principal } from './principal';

export type ProjectAccessMode = 'read' | 'write';

export type ProjectRecord = {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  description: string | null;
  status: 'active' | 'archived';
};

/**
 * Missing and unauthorized are the same error. Archived is reported only
 * after access is confirmed, and only on write. Defaults are not consulted.
 */
export async function assertProjectAccess(
  tx: DbTx,
  principal: Principal,
  projectId: string,
  mode: ProjectAccessMode,
): Promise<ProjectRecord> {
  if (!principal.orgId) throw new DomainError('forbidden_or_not_found');
  const rows = await tx.select({
    id: projects.id,
    orgId: projects.orgId,
    slug: projects.slug,
    name: projects.name,
    description: projects.description,
    status: projects.status,
  }).from(projects).where(and(
    eq(projects.id, projectId),
    eq(projects.orgId, principal.orgId),
  )).limit(1);
  const project = rows[0];
  if (!project) throw new DomainError('forbidden_or_not_found');
  if (principal.kind === 'agent' && principal.scope === 'projects') {
    const grants = await tx.select({ projectId: tokenProjectGrants.projectId }).from(tokenProjectGrants).where(and(
      eq(tokenProjectGrants.orgId, principal.orgId),
      eq(tokenProjectGrants.tokenId, principal.tokenId),
      eq(tokenProjectGrants.projectId, projectId),
    )).limit(1);
    if (!grants[0]) throw new DomainError('forbidden_or_not_found');
  }
  const status = project.status === 'archived' ? 'archived' : 'active';
  if (mode === 'write' && status === 'archived') throw new DomainError('project_archived');
  return { ...project, status };
}

/** Project ids the principal may read. Archived rows are omitted unless asked. Defaults never add ids. */
export async function accessibleProjectIds(
  tx: DbTx,
  principal: Principal,
  options: { includeArchived: boolean },
): Promise<string[]> {
  if (!principal.orgId) return [];
  const rows = await tx.select({ id: projects.id, status: projects.status }).from(projects).where(
    eq(projects.orgId, principal.orgId),
  );
  const visible = rows.filter((row) => options.includeArchived || row.status === 'active');
  if (principal.kind === 'agent' && principal.scope === 'projects') {
    const grants = await tx.select({ projectId: tokenProjectGrants.projectId }).from(tokenProjectGrants).where(and(
      eq(tokenProjectGrants.orgId, principal.orgId),
      eq(tokenProjectGrants.tokenId, principal.tokenId),
    ));
    const allowed = new Set(grants.map((grant) => grant.projectId));
    return visible.filter((row) => allowed.has(row.id)).map((row) => row.id);
  }
  return visible.map((row) => row.id);
}
