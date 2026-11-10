import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbTx } from '../../db/client';
import { organizations } from '../../db/schema/org';
import { agentTokens, agents } from '../../db/schema/identity';
import { agentProjectDefaults, tokenProjectGrants } from '../../db/schema/projects';
import { agentSessionProjects, agentSessions } from '../../db/schema/sessions';
import { appendEvents, assertProjectAccess, DomainError, newId, withOrgTx, withTokenLookupTx, writeAudit } from '../kernel';
import type { AgentPrincipal, InterfaceKind, Principal, TxContext } from '../kernel';
import { listProjectsInTx, requireId, requireOwner, textField } from '../projects';
import { hashSecret, matchesSecret, randomBase62 } from './secrets';

const tokenColumns = {
  id: agentTokens.id, label: agentTokens.label, prefix: agentTokens.prefix, scope: agentTokens.scope,
  canCreateProjects: agentTokens.canCreateProjects, expiresAt: agentTokens.expiresAt, revokedAt: agentTokens.revokedAt,
  lastUsedAt: agentTokens.lastUsedAt, createdAt: agentTokens.createdAt, updatedAt: agentTokens.updatedAt,
};
function agentOnly(principal: Principal, resolved = false): asserts principal is AgentPrincipal {
  if (principal.kind !== 'agent') throw new DomainError('capability_denied');
  if (resolved && (!principal.agentId || !principal.sessionId)) throw new DomainError('unauthenticated');
}
async function audit(tx: DbTx, ctx: TxContext, action: string, entityType: string, entityId: string, before: Record<string, unknown> | null = null, after: Record<string, unknown> | null = null) {
  await writeAudit(tx, ctx, { action, entityType, entityId, before, after });
}
async function accessEvent(tx: DbTx, ctx: TxContext, entityType: string, entityId: string) {
  await appendEvents(tx, ctx.orgId, [{ kind: 'access.changed', entityType, entityId }]);
}
export async function authenticateBearer(authorizationHeader: string | null | undefined, options: { requestId: string; interface: InterfaceKind }): Promise<AgentPrincipal> {
  const match = typeof authorizationHeader === 'string' ? /^Bearer (amb_([0-9A-Za-z]{8})_[0-9A-Za-z]{40})$/i.exec(authorizationHeader) : null;
  if (!match || !match[1]!.startsWith('amb_')) throw new DomainError('unauthenticated');
  const token = await withTokenLookupTx(match[2]!, async (_tx, row) => {
    const matches = matchesSecret(match[1]!, row?.tokenHash ?? '0'.repeat(64));
    if (!row || !matches || row.revokedAt || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) throw new DomainError('unauthenticated');
    return row;
  });
  const principal: AgentPrincipal = { kind: 'agent', orgId: token.orgId, tokenId: token.id, scope: token.scope,
    projectIds: token.scope === 'org' ? 'all' : [], canCreateProjects: token.canCreateProjects,
    agentId: null, sessionId: null, requestId: options.requestId, interface: options.interface };
  return withOrgTx(principal, async (tx, ctx) => {
    await tx.update(agentTokens).set({ lastUsedAt: new Date() }).where(eq(agentTokens.id, token.id));
    return { ...principal, projectIds: ctx.projectIds, canCreateProjects: ctx.canCreateProjects };
  });
}
export type CreateTokenInput = { label: string; scope: 'org' | 'projects'; projectIds?: string[]; canCreateProjects?: boolean; expiresAt?: string | Date | null };
async function validateProjects(tx: DbTx, ctx: TxContext, projectIds: readonly string[]) {
  for (const id of projectIds) { requireId(id); await assertProjectAccess(tx, ctx.principal, id, 'read'); }
}
async function issueToken(tx: DbTx, ctx: TxContext, input: CreateTokenInput) {
  requireOwner(ctx.principal);
  textField(input.label, 'label', 200);
  if (input.scope !== 'org' && input.scope !== 'projects') throw new DomainError('validation_failed', { field: 'scope' });
  if (input.canCreateProjects !== undefined && typeof input.canCreateProjects !== 'boolean') throw new DomainError('validation_failed', { field: 'canCreateProjects' });
  const ids = [...new Set(input.projectIds ?? [])];
  if (input.scope === 'org' && ids.length) throw new DomainError('validation_failed', { field: 'projectIds' });
  await validateProjects(tx, ctx, ids);
  const expiresAt = input.expiresAt == null ? null : new Date(input.expiresAt);
  if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) throw new DomainError('validation_failed', { field: 'expiresAt' });
  // Prefix collisions are handled without aborting the surrounding transaction.
  for (;;) {
    const prefix = randomBase62(8);
    const secret = `amb_${prefix}_${randomBase62(40)}`;
    const [row] = await tx.insert(agentTokens).values({ id: newId(), orgId: ctx.orgId, label: input.label, prefix,
      tokenHash: hashSecret(secret), scope: input.scope, canCreateProjects: input.canCreateProjects ?? input.scope === 'org',
      expiresAt, createdByUserId: ctx.principal.userId,
    }).onConflictDoNothing({ target: agentTokens.prefix }).returning(tokenColumns);
    if (!row) continue;
    if (ids.length) await tx.insert(tokenProjectGrants).values(ids.map((projectId) => ({ orgId: ctx.orgId, tokenId: row.id, projectId, source: 'owner' })));
    await accessEvent(tx, ctx, 'credential', row.id);
    await audit(tx, ctx, 'credential.create', 'credential', row.id, null, { label: row.label, prefix: row.prefix, scope: row.scope, projectIds: ids, canCreateProjects: row.canCreateProjects });
    return { token: serializeToken(row, ids), secret };
  }
}
function serializeToken<T extends { createdAt: Date; updatedAt: Date; expiresAt: Date | null; revokedAt: Date | null; lastUsedAt: Date | null }>(row: T, projectIds: string[]) {
  const { createdAt, updatedAt, expiresAt, revokedAt, lastUsedAt, ...metadata } = row;
  return { ...metadata, projectIds, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString(),
    expiresAt: expiresAt?.toISOString() ?? null, revokedAt: revokedAt?.toISOString() ?? null, lastUsedAt: lastUsedAt?.toISOString() ?? null };
}
export function createToken(principal: Principal, input: CreateTokenInput) {
  requireOwner(principal); return withOrgTx(principal, (tx, ctx) => issueToken(tx, ctx, input));
}
export async function listTokensInTx(tx: DbTx, ctx: TxContext) {
  requireOwner(ctx.principal);
  const rows = await tx.select(tokenColumns).from(agentTokens).where(eq(agentTokens.orgId, ctx.orgId)).orderBy(asc(agentTokens.createdAt));
  const grants = await tx.select().from(tokenProjectGrants).where(eq(tokenProjectGrants.orgId, ctx.orgId));
  return rows.map((row) => serializeToken(row, grants.filter((g) => g.tokenId === row.id).map((g) => g.projectId)));
}
export function listTokens(principal: Principal) { requireOwner(principal); return withOrgTx(principal, listTokensInTx); }
async function lockedToken(tx: DbTx, ctx: TxContext, id: string) {
  requireId(id);
  const [row] = await tx.select(tokenColumns).from(agentTokens).where(and(eq(agentTokens.id, id), eq(agentTokens.orgId, ctx.orgId))).for('update');
  if (!row) throw new DomainError('forbidden_or_not_found');
  return row;
}
export function revokeToken(principal: Principal, tokenId: string) {
  requireOwner(principal);
  return withOrgTx(principal, async (tx, ctx) => {
    const before = await lockedToken(tx, ctx, tokenId);
    const revokedAt = before.revokedAt ?? new Date();
    await tx.update(agentTokens).set({ revokedAt, updatedAt: new Date() }).where(eq(agentTokens.id, tokenId));
    await accessEvent(tx, ctx, 'credential', tokenId);
    await audit(tx, ctx, 'credential.revoke', 'credential', tokenId, { revokedAt: before.revokedAt?.toISOString() ?? null }, { revokedAt: revokedAt.toISOString() });
    return { id: tokenId, revokedAt: revokedAt.toISOString() };
  });
}
export function replaceToken(principal: Principal, tokenId: string) {
  requireOwner(principal);
  return withOrgTx(principal, async (tx, ctx) => {
    const row = await lockedToken(tx, ctx, tokenId);
    const grants = await tx.select().from(tokenProjectGrants).where(eq(tokenProjectGrants.tokenId, tokenId));
    const result = await issueToken(tx, ctx, { label: row.label, scope: row.scope as 'org' | 'projects', projectIds: grants.map((g) => g.projectId), canCreateProjects: row.canCreateProjects, expiresAt: row.expiresAt });
    await audit(tx, ctx, 'credential.replace', 'credential', tokenId, null, { replacementId: result.token.id });
    return result;
  });
}
export function setTokenGrants(principal: Principal, tokenId: string, projectIds: string[]) {
  requireOwner(principal);
  return withOrgTx(principal, async (tx, ctx) => {
    const row = await lockedToken(tx, ctx, tokenId);
    if (row.scope !== 'projects') throw new DomainError('validation_failed', { field: 'scope' });
    const ids = [...new Set(projectIds)]; await validateProjects(tx, ctx, ids);
    const before = await tx.select().from(tokenProjectGrants).where(eq(tokenProjectGrants.tokenId, tokenId));
    await tx.delete(tokenProjectGrants).where(eq(tokenProjectGrants.tokenId, tokenId));
    if (ids.length) await tx.insert(tokenProjectGrants).values(ids.map((projectId) => ({ orgId: ctx.orgId, tokenId, projectId, source: 'owner' })));
    await accessEvent(tx, ctx, 'credential', tokenId);
    await audit(tx, ctx, 'credential.grants', 'credential', tokenId, { projectIds: before.map((g) => g.projectId) }, { projectIds: ids });
    return { id: tokenId, projectIds: ids };
  });
}
export async function listAgentsInTx(tx: DbTx, ctx: TxContext) {
  requireOwner(ctx.principal);
  const rows = await tx.select().from(agents).where(eq(agents.orgId, ctx.orgId)).orderBy(asc(agents.name));
  return rows.map(serializeAgent);
}
function serializeAgent(row: typeof agents.$inferSelect) { return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), lastSeenAt: row.lastSeenAt?.toISOString() ?? null }; }
export function listAgents(principal: Principal) { requireOwner(principal); return withOrgTx(principal, listAgentsInTx); }
export async function listAgentSessionsInTx(tx: DbTx, ctx: TxContext, agentId: string) {
  requireOwner(ctx.principal); await requireAgent(tx, ctx, agentId);
  const rows = await tx.select({ id: agentSessions.id, agentId: agentSessions.agentId, tokenPrefix: agentTokens.prefix,
    clientLabel: agentSessions.clientLabel, createdAt: agentSessions.createdAt, lastSeenAt: agentSessions.lastSeenAt,
  }).from(agentSessions).innerJoin(agentTokens, and(eq(agentTokens.id, agentSessions.tokenId), eq(agentTokens.orgId, agentSessions.orgId)))
    .where(and(eq(agentSessions.orgId, ctx.orgId), eq(agentSessions.agentId, agentId))).orderBy(asc(agentSessions.createdAt));
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), lastSeenAt: row.lastSeenAt.toISOString() }));
}
export function listAgentSessions(principal: Principal, agentId: string) { requireOwner(principal); return withOrgTx(principal, (tx, ctx) => listAgentSessionsInTx(tx, ctx, agentId)); }
async function requireAgent(tx: DbTx, ctx: TxContext, agentId: string, lock = false) {
  requireId(agentId);
  const query = tx.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.orgId, ctx.orgId)));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new DomainError('forbidden_or_not_found');
  return row;
}
export function setAgentDefaults(principal: Principal, agentId: string, projectIds: string[]) {
  requireOwner(principal);
  return withOrgTx(principal, async (tx, ctx) => {
    await requireAgent(tx, ctx, agentId, true);
    const ids = [...new Set(projectIds)]; await validateProjects(tx, ctx, ids);
    const before = await tx.select().from(agentProjectDefaults).where(eq(agentProjectDefaults.agentId, agentId));
    await tx.delete(agentProjectDefaults).where(eq(agentProjectDefaults.agentId, agentId));
    if (ids.length) await tx.insert(agentProjectDefaults).values(ids.map((projectId) => ({ orgId: ctx.orgId, agentId, projectId })));
    await accessEvent(tx, ctx, 'agent', agentId);
    await audit(tx, ctx, 'agent.defaults', 'agent', agentId, { projectIds: before.map((d) => d.projectId) }, { projectIds: ids });
    return { agentId, projectIds: ids };
  });
}
/** Active defaults intersected with fresh transaction grants; never authority themselves. */
export async function getAgentDefaultsInTx(tx: DbTx, ctx: TxContext, agentId: string) {
  requireId(agentId);
  if (ctx.principal.kind === 'agent' && ctx.principal.agentId !== agentId) throw new DomainError('forbidden_or_not_found');
  await requireAgent(tx, ctx, agentId);
  const defaults = await tx.select().from(agentProjectDefaults).where(and(eq(agentProjectDefaults.orgId, ctx.orgId), eq(agentProjectDefaults.agentId, agentId)));
  const ids = new Set(defaults.map((d) => d.projectId));
  return (await listProjectsInTx(tx, ctx)).filter((p) => ids.has(p.id) && (ctx.projectIds === 'all' || ctx.projectIds.includes(p.id)));
}
export function getAgentDefaults(principal: Principal, agentId: string) { return withOrgTx(principal, (tx, ctx) => getAgentDefaultsInTx(tx, ctx, agentId)); }
export function connectAgent(principal: AgentPrincipal, input: { name: string; clientLabel?: string }) {
  agentOnly(principal);
  if (typeof input.name !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(input.name)) throw new DomainError('validation_failed', { field: 'name' });
  if (input.clientLabel !== undefined) textField(input.clientLabel, 'clientLabel', 200);
  return withOrgTx(principal, async (tx, ctx) => {
    await tx.insert(agents).values({ id: newId(), orgId: ctx.orgId, name: input.name }).onConflictDoNothing();
    const [agent] = await tx.select().from(agents).where(and(eq(agents.orgId, ctx.orgId), sql`lower(${agents.name}) = lower(${input.name})`));
    if (!agent) throw new DomainError('unavailable');
    const sessionId = newId();
    await tx.insert(agentSessions).values({ id: sessionId, orgId: ctx.orgId, agentId: agent.id, tokenId: principal.tokenId, clientLabel: input.clientLabel ?? null });
    const [seen] = await tx.update(agents).set({ lastSeenAt: new Date(), updatedAt: new Date() }).where(eq(agents.id, agent.id)).returning();
    const resolved = { ...ctx, principal: { ...principal, agentId: agent.id, sessionId } };
    await audit(tx, resolved, 'agent.connect', 'agent_session', sessionId, null, { agentId: agent.id, clientLabel: input.clientLabel ?? null });
    const defaults = await getAgentDefaultsInTx(tx, resolved, agent.id);
    return { agent: serializeAgent(seen!), sessionId, capabilities: { canCreateProjects: ctx.canCreateProjects }, defaults: defaults.map((p) => ({ id: p.id, slug: p.slug, name: p.name })) };
  });
}
export function resolveAgentSession(principal: AgentPrincipal, sessionId: string): Promise<AgentPrincipal> {
  agentOnly(principal);
  // Validate before sending a UUID to PostgreSQL; invalid and foreign handles match.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw new DomainError('unauthenticated');
  return withOrgTx(principal, async (tx, ctx) => {
    const [session] = await tx.select().from(agentSessions).where(and(eq(agentSessions.id, sessionId), eq(agentSessions.orgId, ctx.orgId), eq(agentSessions.tokenId, principal.tokenId)));
    if (!session) throw new DomainError('unauthenticated');
    const now = new Date();
    await tx.update(agentSessions).set({ lastSeenAt: now }).where(eq(agentSessions.id, sessionId));
    await tx.update(agents).set({ lastSeenAt: now, updatedAt: now }).where(eq(agents.id, session.agentId));
    const resolved = { ...principal, agentId: session.agentId, sessionId, projectIds: ctx.projectIds, canCreateProjects: ctx.canCreateProjects };
    await audit(tx, { ...ctx, principal: resolved }, 'agent.session_seen', 'agent_session', sessionId);
    return resolved;
  });
}
export function selectSessionProjects(principal: AgentPrincipal, projectIds: string[]) {
  agentOnly(principal, true);
  return withOrgTx(principal, async (tx, ctx) => {
    await tx.select({ id: agentSessions.id }).from(agentSessions).where(eq(agentSessions.id, principal.sessionId!)).for('update');
    const defaults = await getAgentDefaultsInTx(tx, ctx, principal.agentId!);
    const ids = [...new Set(projectIds)];
    if (ids.some((id) => !defaults.some((p) => p.id === id))) throw new DomainError('forbidden_or_not_found');
    const before = await tx.select().from(agentSessionProjects).where(eq(agentSessionProjects.sessionId, principal.sessionId!));
    await tx.delete(agentSessionProjects).where(eq(agentSessionProjects.sessionId, principal.sessionId!));
    if (ids.length) await tx.insert(agentSessionProjects).values(ids.map((projectId) => ({ orgId: ctx.orgId, sessionId: principal.sessionId!, projectId })));
    await audit(tx, ctx, 'agent.session_projects', 'agent_session', principal.sessionId!, { projectIds: before.map((p) => p.projectId) }, { projectIds: ids });
    return { projectIds: ids };
  });
}
export async function resolveTargetProjectsInTx(tx: DbTx, ctx: TxContext, input: { projectId?: string; mode: 'read' | 'write' }) {
  agentOnly(ctx.principal, true);
  if (input.mode !== 'read' && input.mode !== 'write') throw new DomainError('validation_failed', { field: 'mode' });
  if (input.projectId !== undefined) {
    requireId(input.projectId);
    return [await assertProjectAccess(tx, ctx.principal, input.projectId, input.mode)];
  }
  const defaults = await getAgentDefaultsInTx(tx, ctx, ctx.principal.agentId!);
  const selections = await tx.select().from(agentSessionProjects).where(and(eq(agentSessionProjects.orgId, ctx.orgId), eq(agentSessionProjects.sessionId, ctx.principal.sessionId!)));
  const selectedIds = new Set(selections.map((p) => p.projectId));
  const targets = selections.length ? defaults.filter((p) => selectedIds.has(p.id)) : defaults;
  if (!targets.length) throw new DomainError('no_project_selected', { instruction: 'Ask the owner to assign an accessible active default project.' });
  if (input.mode === 'write' && targets.length !== 1) throw new DomainError('ambiguous_project', { projects: targets.map((p) => ({ id: p.id, slug: p.slug, name: p.name })) });
  return targets.map((p) => ({ id: p.id, orgId: p.orgId, slug: p.slug, name: p.name, description: p.description, status: p.status as 'active' | 'archived' }));
}
export function resolveTargetProjects(principal: AgentPrincipal, input: { projectId?: string; mode: 'read' | 'write' }) {
  agentOnly(principal, true); return withOrgTx(principal, (tx, ctx) => resolveTargetProjectsInTx(tx, ctx, input));
}


/** Owner onboarding is atomic: no credential or identity survives a failed setup. */
export function setupAgentConnection(principal: Principal, input: {
  agentName: string; clientLabel?: string; token: CreateTokenInput; defaultProjectIds: string[];
}) {
  requireOwner(principal);
  if (typeof input.agentName !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(input.agentName)) throw new DomainError('validation_failed', { field: 'agentName' });
  if (input.clientLabel !== undefined) textField(input.clientLabel, 'clientLabel', 200);
  return withOrgTx(principal, async (tx, ctx) => {
    const ids = [...new Set(input.defaultProjectIds)];
    await validateProjects(tx, ctx, ids);
    if (input.token.scope === 'projects' && ids.some((id) => !input.token.projectIds?.includes(id))) throw new DomainError('validation_failed', { field: 'defaultProjectIds' });
    const inserted = await tx.insert(agents).values({ id: newId(), orgId: ctx.orgId, name: input.agentName }).onConflictDoNothing().returning();
    const [agent] = await tx.select().from(agents).where(and(eq(agents.orgId, ctx.orgId), sql`lower(${agents.name}) = lower(${input.agentName})`)).for('update');
    if (!agent) throw new DomainError('unavailable');
    if (inserted.length) await audit(tx, ctx, 'agent.register', 'agent', agent.id, null, { name: agent.name });
    const issued = await issueToken(tx, ctx, input.token);
    const before = await tx.select().from(agentProjectDefaults).where(and(eq(agentProjectDefaults.orgId, ctx.orgId), eq(agentProjectDefaults.agentId, agent.id)));
    await tx.delete(agentProjectDefaults).where(and(eq(agentProjectDefaults.orgId, ctx.orgId), eq(agentProjectDefaults.agentId, agent.id)));
    if (ids.length) await tx.insert(agentProjectDefaults).values(ids.map((projectId) => ({ orgId: ctx.orgId, agentId: agent.id, projectId })));
    await accessEvent(tx, ctx, 'agent', agent.id);
    await audit(tx, ctx, 'agent.defaults', 'agent', agent.id, { projectIds: before.map((d) => d.projectId) }, { projectIds: ids });
    return { ...issued, agent: serializeAgent(agent), defaultProjectIds: ids };
  });
}

/** Reads recorded sessions only; never accepts or uses a bearer secret. */
export function getConnectionDiagnostics(principal: Principal, input: { agentId: string; tokenId: string }) {
  requireOwner(principal);
  return withOrgTx(principal, async (tx, ctx) => {
    const agent = await requireAgent(tx, ctx, input.agentId);
    const token = await lockedToken(tx, ctx, input.tokenId);
    const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, ctx.orgId));
    const grants = await tx.select().from(tokenProjectGrants).where(and(eq(tokenProjectGrants.orgId, ctx.orgId), eq(tokenProjectGrants.tokenId, token.id)));
    const allowed = new Set(grants.map((g) => g.projectId));
    const projects = (await listProjectsInTx(tx, ctx, { includeArchived: true }))
      .filter((p) => token.scope === 'org' || allowed.has(p.id))
      .map((p) => ({ id: p.id, slug: p.slug, name: p.name, access: p.status === 'archived' ? 'read-only' as const : 'read/write' as const }));
    const defaults = await tx.select().from(agentProjectDefaults).where(and(eq(agentProjectDefaults.orgId, ctx.orgId), eq(agentProjectDefaults.agentId, agent.id)));
    const defaultIds = new Set(defaults.map((d) => d.projectId));
    const sessions = await tx.select({ id: agentSessions.id, clientLabel: agentSessions.clientLabel, createdAt: agentSessions.createdAt, lastSeenAt: agentSessions.lastSeenAt })
      .from(agentSessions).where(and(eq(agentSessions.orgId, ctx.orgId), eq(agentSessions.agentId, agent.id), eq(agentSessions.tokenId, token.id))).orderBy(asc(agentSessions.createdAt));
    return { tokenStatus: token.revokedAt ? 'Revoked' : token.expiresAt && token.expiresAt.getTime() <= Date.now() ? 'Expired' : 'Live', org: { name: org!.name }, agent: serializeAgent(agent), token: serializeToken(token, [...allowed]),
      sessions: sessions.map((s) => ({ ...s, createdAt: s.createdAt.toISOString(), lastSeenAt: s.lastSeenAt.toISOString() })),
      projects, defaults: projects.filter((p) => defaultIds.has(p.id) && p.access === 'read/write'),
      capabilities: { canCreateProjects: token.canCreateProjects } };
  });
}
