import { and, eq, sql } from 'drizzle-orm';
import type { AppDatabase, DbTx } from '../../db/client';
import { getDb } from '../../db/client';
import { agentTokens, agents } from '../../db/schema/identity';
import { orgMembers, organizations } from '../../db/schema/org';
import { projects, tokenProjectGrants } from '../../db/schema/projects';
import { agentSessions } from '../../db/schema/sessions';
import { DomainError } from './errors';
import { isUuid } from './ids';
import type { Principal } from './principal';

export type TxContext = {
  principal: Principal;
  orgId: string;
  requestId: string;
  /** Current project allowlist. `'all'` for owners, members, org-wide tokens, and system. */
  projectIds: readonly string[] | 'all';
  canCreateProjects: boolean;
  /** Human role re-read in this transaction. Null for agents and system. */
  role: 'owner' | 'member' | null;
};

export type TokenAuthView = {
  id: string;
  orgId: string;
  prefix: string;
  tokenHash: string;
  scope: 'org' | 'projects';
  canCreateProjects: boolean;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

/**
 * One transaction scoped to the principal's org. Sets `app.org_id`, then
 * re-reads the org, and for agents the token and grants, before `fn` runs.
 * A suspended org, revoked or expired token, or an allowlist entry that is
 * no longer granted aborts the transaction.
 */
export async function withOrgTx<T>(
  principal: Principal,
  fn: (tx: DbTx, ctx: TxContext) => Promise<T>,
  database: AppDatabase = getDb(),
): Promise<T> {
  if (!principal.orgId || !isUuid(principal.orgId)) throw new DomainError('forbidden_or_not_found');
  if (!principal.requestId) throw new DomainError('validation_failed', { field: 'requestId' });
  const orgId = principal.orgId;
  return database.transaction(async (tx) => {
    await setLocal(tx, 'app.org_id', orgId);
    const org = await tx.select({
      status: organizations.status,
      ownerUserId: organizations.ownerUserId,
    }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
    const row = org[0];
    if (!row) throw new DomainError('forbidden_or_not_found');
    if (row.status !== 'active') throw new DomainError('org_suspended');

    let projectIds: readonly string[] | 'all' = 'all';
    let canCreateProjects = false;
    let role: 'owner' | 'member' | null = null;
    if (principal.kind === 'human') {
      if (row.ownerUserId === principal.userId) {
        role = 'owner';
        canCreateProjects = true;
      } else {
        // Re-read membership every call — never trust principal.role alone.
        const [member] = await tx.select({
          canCreateProjects: orgMembers.canCreateProjects,
        }).from(orgMembers).where(and(
          eq(orgMembers.orgId, orgId),
          eq(orgMembers.userId, principal.userId),
        )).limit(1);
        if (!member) throw new DomainError('forbidden_or_not_found');
        role = 'member';
        canCreateProjects = member.canCreateProjects;
      }
    } else if (principal.kind === 'agent') {
      const fresh = await freshAgent(tx, principal);
      projectIds = fresh.projectIds;
      canCreateProjects = fresh.canCreateProjects;
    } else {
      canCreateProjects = true;
    }

    return fn(tx, {
      principal,
      orgId,
      requestId: principal.requestId,
      projectIds,
      canCreateProjects,
      role,
    });
  });
}

/** Owner-only operations must use the role from this transaction, not principal.role. */
export function requireTxOwner(ctx: TxContext): void {
  if (ctx.principal.kind !== 'human' || ctx.role !== 'owner') {
    throw new DomainError('capability_denied');
  }
}

/**
 * Sets `app.org_id` for one existing organization so system maintenance
 * (retention) is subject to FORCE row-level security. Grep for
 * withOrgMaintenanceTx. Does not check org status, site admin, or a
 * principal. Not for creating an organization — that is withOrgBootstrapTx.
 */
export async function withOrgMaintenanceTx<T>(
  orgId: string,
  fn: (tx: DbTx) => Promise<T>,
  database: AppDatabase = getDb(),
): Promise<T> {
  if (!isUuid(orgId)) throw new DomainError('validation_failed', { field: 'orgId' });
  return database.transaction(async (tx) => {
    await setLocal(tx, 'app.org_id', orgId);
    return fn(tx);
  });
}

/**
 * Sets `app.org_id` to a new organization id before the row exists, so the
 * counter trigger's insert satisfies RLS. Grep for withOrgBootstrapTx.
 * Does not check that the org is active — it is being created.
 */
export async function withOrgBootstrapTx<T>(
  orgId: string,
  fn: (tx: DbTx) => Promise<T>,
  database: AppDatabase = getDb(),
): Promise<T> {
  if (!isUuid(orgId)) throw new DomainError('validation_failed', { field: 'orgId' });
  return database.transaction(async (tx) => {
    await setLocal(tx, 'app.org_id', orgId);
    return fn(tx);
  });
}

/**
 * Token authentication bootstrap. Sets only `app.token_prefix` (and clears
 * `app.org_id`) so the policy returns the one matching token. Grep for
 * withTokenLookupTx. The callback sees that token or null, never the rest.
 */
export async function withTokenLookupTx<T>(
  prefix: string,
  fn: (tx: DbTx, token: TokenAuthView | null) => Promise<T>,
  database: AppDatabase = getDb(),
): Promise<T> {
  if (!/^[0-9A-Za-z]{8}$/.test(prefix)) {
    return database.transaction(async (tx) => fn(tx, null));
  }
  return database.transaction(async (tx) => {
    await setLocal(tx, 'app.org_id', '');
    await setLocal(tx, 'app.token_prefix', prefix);
    const rows = await tx.select({
      id: agentTokens.id,
      orgId: agentTokens.orgId,
      prefix: agentTokens.prefix,
      tokenHash: agentTokens.tokenHash,
      scope: agentTokens.scope,
      canCreateProjects: agentTokens.canCreateProjects,
      expiresAt: agentTokens.expiresAt,
      revokedAt: agentTokens.revokedAt,
    }).from(agentTokens).where(eq(agentTokens.prefix, prefix)).limit(2);
    if (rows.length !== 1) return fn(tx, null);
    const token = rows[0];
    if (!token) return fn(tx, null);
    return fn(tx, {
      ...token,
      scope: token.scope === 'org' ? 'org' : 'projects',
    });
  });
}

export type PublicProjectGate = {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  description: string | null;
};

/**
 * Anonymous read of one project. Sets `app.org_id` so FORCE RLS can see that
 * org, then confirms the project is public and active before `fn` runs.
 * A missing, private, or archived project throws `forbidden_or_not_found`
 * and `fn` does not run. Grep for withPublicReadTx. No principal is checked:
 * the caller has already resolved an active organization by its public slug.
 * `app.org_id` is set before the confirmation because a project row is
 * invisible under FORCE RLS until that setting exists. The callback is the
 * read, and it starts only after the gate passes.
 */
export async function withPublicReadTx<T>(
  orgId: string,
  projectSlug: string,
  fn: (tx: DbTx, project: PublicProjectGate) => Promise<T>,
  database: AppDatabase = getDb(),
): Promise<T> {
  if (!isUuid(orgId)) throw new DomainError('forbidden_or_not_found');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(projectSlug)) throw new DomainError('forbidden_or_not_found');
  return database.transaction(async (tx) => {
    await setLocal(tx, 'app.org_id', orgId);
    const [row] = await tx.select({
      id: projects.id,
      orgId: projects.orgId,
      slug: projects.slug,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      visibility: projects.visibility,
    }).from(projects).where(and(eq(projects.orgId, orgId), eq(projects.slug, projectSlug))).limit(1);
    if (!row || row.status !== 'active' || row.visibility !== 'public') {
      throw new DomainError('forbidden_or_not_found');
    }
    return fn(tx, {
      id: row.id,
      orgId: row.orgId,
      slug: row.slug,
      name: row.name,
      description: row.description,
    });
  });
}

/**
 * Site-announcement writes. Sets `app.site_admin` and does not set an org.
 * Grep for withSiteAdminTx. This is not board access.
 */
export async function withSiteAdminTx<T>(
  fn: (tx: DbTx) => Promise<T>,
  database: AppDatabase = getDb(),
): Promise<T> {
  return database.transaction(async (tx) => {
    await setLocal(tx, 'app.org_id', '');
    await setLocal(tx, 'app.site_admin', '1');
    return fn(tx);
  });
}

export async function setLocal(tx: DbTx, key: 'app.org_id' | 'app.token_prefix' | 'app.site_admin', value: string): Promise<void> {
  await tx.execute(sql`select set_config(${key}, ${value}, true)`);
}

async function freshAgent(
  tx: DbTx,
  principal: Extract<Principal, { kind: 'agent' }>,
): Promise<{ projectIds: readonly string[] | 'all'; canCreateProjects: boolean }> {
  if (!isUuid(principal.tokenId)) throw new DomainError('unauthenticated');
  const tokens = await tx.select({
    id: agentTokens.id,
    orgId: agentTokens.orgId,
    scope: agentTokens.scope,
    canCreateProjects: agentTokens.canCreateProjects,
  }).from(agentTokens).where(and(
    eq(agentTokens.id, principal.tokenId),
    sql`${agentTokens.revokedAt} is null`,
    sql`(${agentTokens.expiresAt} is null or ${agentTokens.expiresAt} > now())`,
  )).limit(1);
  const token = tokens[0];
  if (!token || token.orgId !== principal.orgId) throw new DomainError('unauthenticated');

  if (principal.agentId) {
    if (!isUuid(principal.agentId)) throw new DomainError('unauthenticated');
    const found = await tx.select({ id: agents.id }).from(agents).where(and(
      eq(agents.id, principal.agentId),
      eq(agents.orgId, principal.orgId),
    )).limit(1);
    if (!found[0]) throw new DomainError('unauthenticated');
  }
  if (principal.sessionId) {
    if (!isUuid(principal.sessionId)) throw new DomainError('unauthenticated');
    const found = await tx.select({ id: agentSessions.id }).from(agentSessions).where(and(
      eq(agentSessions.id, principal.sessionId),
      eq(agentSessions.orgId, principal.orgId),
      eq(agentSessions.tokenId, principal.tokenId),
      principal.agentId ? eq(agentSessions.agentId, principal.agentId) : sql`true`,
    )).limit(1);
    if (!found[0]) throw new DomainError('unauthenticated');
  }

  if (token.scope === 'org') {
    return { projectIds: 'all', canCreateProjects: token.canCreateProjects };
  }
  if (principal.projectIds === 'all') throw new DomainError('forbidden_or_not_found');
  const grants = await tx.select({ projectId: tokenProjectGrants.projectId }).from(tokenProjectGrants).where(and(
    eq(tokenProjectGrants.orgId, principal.orgId),
    eq(tokenProjectGrants.tokenId, principal.tokenId),
  ));
  const current = new Set(grants.map((grant) => grant.projectId));
  for (const projectId of principal.projectIds) {
    if (!current.has(projectId)) throw new DomainError('forbidden_or_not_found');
  }
  return { projectIds: [...current], canCreateProjects: token.canCreateProjects };
}
