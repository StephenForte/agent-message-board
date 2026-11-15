import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { AppDatabase, DbTx } from '../../db/client';
import { getDb } from '../../db/client';
import { user } from '../../db/schema/auth';
import { announcementRevisions, announcements } from '../../db/schema/announcements';
import { siteAdmins } from '../../db/schema/site-admins';
import { writeAudit } from '../kernel/audit';
import { DomainError, versionConflict } from '../kernel/errors';
import { assertProjectAccess, isUuid } from '../kernel';
import { newId } from '../kernel/ids';
import type { HumanPrincipal, Principal } from '../kernel/principal';
import type { TxContext } from '../kernel/tx';
import { withOrgTx, withSiteAdminTx } from '../kernel/tx';
import {
  assertAnnouncementContent,
  assertAnnouncementScope,
  assertExpectedVersion,
  assertRevisionLimit,
  type AnnouncementScope,
} from './content';

export type { AnnouncementScope } from './content';

/** A live announcement. Cleared rows are returned as null by the readers, not as this shape. */
export type Announcement = {
  id: string;
  scope: AnnouncementScope;
  title: string;
  body: string;
  version: number;
  authorDisplayName: string;
  authorKind: 'human';
  updatedAt: Date;
};

export type AnnouncementPair = {
  site: Announcement | null;
  org: Announcement | null;
};

/** One history row, including clears. Newest version is first when listed. */
export type AnnouncementRevision = {
  id: string;
  scope: AnnouncementScope;
  title: string;
  body: string;
  version: number;
  authorDisplayName: string;
  authorKind: 'human';
  clearedAt: Date | null;
  createdAt: Date;
};

export type AnnouncementContentInput = {
  title: string;
  body: string;
  expectedVersion: number;
};

export type AnnouncementVersionInput = {
  expectedVersion: number;
};

export type AnnouncementMutationResult = {
  id: string;
  scope: AnnouncementScope;
  version: number;
  cleared: boolean;
};

export type ListAnnouncementRevisionsInput = {
  scope: 'site' | 'org';
  /** Default 20. Maximum 100. */
  limit?: number;
};

type AnnouncementState = 'active' | 'cleared';

type StoredRow = {
  id: string;
  version: number;
  title: string;
  body: string;
  clearedAt: Date | null;
};

type Applied = {
  id: string;
  version: number;
  previous: { version: number; cleared: boolean } | null;
};

/**
 * Site and org announcements visible in this transaction. T07 calls this from
 * inside its board-check `withOrgTx`. A cleared row is null. No project data
 * is read.
 */
export async function getAnnouncementsInTx(tx: DbTx, ctx: TxContext): Promise<AnnouncementPair> {
  const rows = await tx.select({
    id: announcements.id,
    scope: announcements.scope,
    orgId: announcements.orgId,
    title: announcements.title,
    body: announcements.body,
    version: announcements.version,
    clearedAt: announcements.clearedAt,
    updatedAt: announcements.updatedAt,
    authorDisplayName: user.name,
  }).from(announcements).innerJoin(user, eq(user.id, announcements.authorUserId))
    .where(or(and(eq(announcements.scope, 'site'), isNull(announcements.orgId)),
      and(eq(announcements.scope, 'org'), eq(announcements.orgId, ctx.orgId))));

  let site: Announcement | null = null;
  let org: Announcement | null = null;
  for (const row of rows) {
    const view = toAnnouncement(row);
    if (!view) continue;
    if (row.scope === 'site' && row.orgId === null) site = view;
    if (row.scope === 'org' && row.orgId === ctx.orgId) org = view;
  }
  return { site, org };
}

/** Owner, org-wide token, and restricted token all read the same pair. */
export async function getAnnouncements(
  principal: Principal,
  database?: AppDatabase,
): Promise<AnnouncementPair> {
  return withOrgTx(principal, (tx, ctx) => getAnnouncementsInTx(tx, ctx), database ?? getDb());
}

/**
 * Org history for the owner, site history for a current site admin. Newest
 * first. Default 20, maximum 100.
 */
export async function listAnnouncementRevisions(
  principal: Principal,
  input: ListAnnouncementRevisionsInput,
  database?: AppDatabase,
): Promise<AnnouncementRevision[]> {
  const human = assertHuman(principal);
  const scope = assertAnnouncementScope(input.scope);
  const limit = assertRevisionLimit(input.limit);
  const db = database ?? getDb();
  if (scope === 'org') {
    return withOrgTx(human, (tx, ctx) => {
      if (ctx.role !== 'owner') throw new DomainError('capability_denied');
      return readRevisions(tx, scope, ctx.orgId, limit);
    }, db);
  }
  return withSiteAdminTx(async (tx) => {
    await assertCurrentSiteAdmin(tx, human.userId);
    return readRevisions(tx, scope, null, limit);
  }, db);
}

export async function setOrgAnnouncement(
  principal: Principal,
  input: AnnouncementContentInput,
  database?: AppDatabase,
): Promise<AnnouncementMutationResult> {
  const human = assertHuman(principal);
  const content = assertAnnouncementContent(input.title, input.body);
  const expectedVersion = assertExpectedVersion(input.expectedVersion);
  return withOrgTx(human, async (tx, ctx) => {
    if (ctx.role !== 'owner') throw new DomainError('capability_denied');
    const applied = await applyMutation(tx, {
      scope: 'org',
      orgId: ctx.orgId,
      authorUserId: human.userId,
      expectedVersion,
      mode: 'set',
      title: content.title,
      body: content.body,
    });
    await writeAudit(tx, ctx, {
      action: 'announcement.set',
      entityType: 'announcement',
      entityId: applied.id,
      before: auditSnapshot(applied.previous),
      after: { version: applied.version, cleared: false },
    });
    return resultOf(applied, 'org', false);
  }, database ?? getDb());
}

export async function clearOrgAnnouncement(
  principal: Principal,
  input: AnnouncementVersionInput,
  database?: AppDatabase,
): Promise<AnnouncementMutationResult> {
  const human = assertHuman(principal);
  const expectedVersion = assertExpectedVersion(input.expectedVersion);
  return withOrgTx(human, async (tx, ctx) => {
    if (ctx.role !== 'owner') throw new DomainError('capability_denied');
    const applied = await applyMutation(tx, {
      scope: 'org',
      orgId: ctx.orgId,
      authorUserId: human.userId,
      expectedVersion,
      mode: 'clear',
    });
    await writeAudit(tx, ctx, {
      action: 'announcement.clear',
      entityType: 'announcement',
      entityId: applied.id,
      before: auditSnapshot(applied.previous),
      after: { version: applied.version, cleared: true },
    });
    return resultOf(applied, 'org', true);
  }, database ?? getDb());
}

/**
 * Site-wide write. `principal.siteAdmin` is not consulted: the `site_admins`
 * row is re-read and locked in this transaction. No audit row (D-023).
 */
export async function setSiteAnnouncement(
  principal: Principal,
  input: AnnouncementContentInput,
  database?: AppDatabase,
): Promise<AnnouncementMutationResult> {
  const human = assertHuman(principal);
  const content = assertAnnouncementContent(input.title, input.body);
  const expectedVersion = assertExpectedVersion(input.expectedVersion);
  return withSiteAdminTx(async (tx) => {
    await assertCurrentSiteAdmin(tx, human.userId);
    const applied = await applyMutation(tx, {
      scope: 'site',
      orgId: null,
      authorUserId: human.userId,
      expectedVersion,
      mode: 'set',
      title: content.title,
      body: content.body,
    });
    return resultOf(applied, 'site', false);
  }, database ?? getDb());
}

/** Same re-check as `setSiteAnnouncement`. Clearing keeps the row and adds a revision. */
export async function clearSiteAnnouncement(
  principal: Principal,
  input: AnnouncementVersionInput,
  database?: AppDatabase,
): Promise<AnnouncementMutationResult> {
  const human = assertHuman(principal);
  const expectedVersion = assertExpectedVersion(input.expectedVersion);
  return withSiteAdminTx(async (tx) => {
    await assertCurrentSiteAdmin(tx, human.userId);
    const applied = await applyMutation(tx, {
      scope: 'site',
      orgId: null,
      authorUserId: human.userId,
      expectedVersion,
      mode: 'clear',
    });
    return resultOf(applied, 'site', true);
  }, database ?? getDb());
}

type Mutation = {
  scope: AnnouncementScope;
  orgId: string | null;
  projectId?: string;
  authorUserId: string;
  expectedVersion: number;
} & ({ mode: 'set'; title: string; body: string } | { mode: 'clear' });

async function applyMutation(tx: DbTx, mutation: Mutation): Promise<Applied> {
  const current = await lockAnnouncement(tx, mutation.scope, mutation.orgId, mutation.projectId);
  if (!current) {
    if (mutation.mode === 'clear' || mutation.expectedVersion !== 0) throw versionConflict(0, null);
    return insertFirst(tx, mutation);
  }
  const state = announcementState(current);
  if (current.version !== mutation.expectedVersion) throw versionConflict(current.version, state);

  const now = new Date();
  const nextVersion = current.version + 1;
  const title = mutation.mode === 'clear' ? current.title : mutation.title;
  const body = mutation.mode === 'clear' ? current.body : mutation.body;
  const clearedAt = mutation.mode === 'clear' ? now : null;
  await tx.update(announcements).set({
    title,
    body,
    version: nextVersion,
    authorUserId: mutation.authorUserId,
    clearedAt,
    updatedAt: now,
  }).where(eq(announcements.id, current.id));
  await insertRevision(tx, {
    announcementId: current.id,
    scope: mutation.scope,
    orgId: mutation.orgId,
    projectId: mutation.projectId,
    title,
    body,
    version: nextVersion,
    authorUserId: mutation.authorUserId,
    clearedAt,
  });
  return {
    id: current.id,
    version: nextVersion,
    previous: { version: current.version, cleared: state === 'cleared' },
  };
}

/**
 * Two first publishes both observe "no row". The partial unique index rejects
 * the loser; that raw error becomes `version_conflict` so the caller can reload.
 */
async function insertFirst(tx: DbTx, mutation: Extract<Mutation, { mode: 'set' }>): Promise<Applied> {
  const id = newId();
  const now = new Date();
  try {
    await tx.transaction(async (inner) => {
      await inner.insert(announcements).values({
        id,
        scope: mutation.scope,
        orgId: mutation.orgId,
        projectId: mutation.projectId,
        title: mutation.title,
        body: mutation.body,
        version: 1,
        authorUserId: mutation.authorUserId,
        clearedAt: null,
        updatedAt: now,
      });
      await insertRevision(inner, {
        announcementId: id,
        scope: mutation.scope,
        orgId: mutation.orgId,
        projectId: mutation.projectId,
        title: mutation.title,
        body: mutation.body,
        version: 1,
        authorUserId: mutation.authorUserId,
        clearedAt: null,
      });
    });
  } catch (error) {
    const expectedConstraint = `announcements_one_${mutation.scope}`;
    if (!isUniqueViolation(error) || postgresConstraint(error) !== expectedConstraint) throw mapLengthCheck(error);
    const winner = await lockAnnouncement(tx, mutation.scope, mutation.orgId, mutation.projectId);
    throw versionConflict(winner?.version ?? 0, winner ? announcementState(winner) : null);
  }
  return { id, version: 1, previous: null };
}

async function lockAnnouncement(tx: DbTx, scope: AnnouncementScope, orgId: string | null, projectId?: string): Promise<StoredRow | null> {
  const where = scope === 'site'
    ? eq(announcements.scope, 'site')
    : and(eq(announcements.scope, scope), eq(announcements.orgId, requiredOrgId(orgId)),
      scope === 'project' ? eq(announcements.projectId, projectId!) : isNull(announcements.projectId));
  const rows = await tx.select({
    id: announcements.id,
    version: announcements.version,
    title: announcements.title,
    body: announcements.body,
    clearedAt: announcements.clearedAt,
  }).from(announcements).where(where).limit(1).for('update');
  return rows[0] ?? null;
}

async function insertRevision(tx: DbTx, row: {
  announcementId: string;
  scope: AnnouncementScope;
  orgId: string | null;
  projectId?: string;
  title: string;
  body: string;
  version: number;
  authorUserId: string;
  clearedAt: Date | null;
}): Promise<void> {
  await tx.insert(announcementRevisions).values({
    id: newId(),
    announcementId: row.announcementId,
    scope: row.scope,
    orgId: row.orgId,
    projectId: row.projectId,
    title: row.title,
    body: row.body,
    version: row.version,
    authorUserId: row.authorUserId,
    clearedAt: row.clearedAt,
  });
}

async function readRevisions(
  tx: DbTx,
  scope: AnnouncementScope,
  orgId: string | null,
  limit: number,
  projectId?: string,
): Promise<AnnouncementRevision[]> {
  const where = scope === 'site'
    ? eq(announcementRevisions.scope, 'site')
    : and(eq(announcementRevisions.scope, scope), eq(announcementRevisions.orgId, requiredOrgId(orgId)),
      scope === 'project' ? eq(announcementRevisions.projectId, projectId!) : isNull(announcementRevisions.projectId));
  const rows = await tx.select({
    id: announcementRevisions.id,
    scope: announcementRevisions.scope,
    orgId: announcementRevisions.orgId,
    title: announcementRevisions.title,
    body: announcementRevisions.body,
    version: announcementRevisions.version,
    clearedAt: announcementRevisions.clearedAt,
    createdAt: announcementRevisions.createdAt,
    authorDisplayName: user.name,
  }).from(announcementRevisions)
    .innerJoin(user, eq(user.id, announcementRevisions.authorUserId))
    .where(where)
    .orderBy(desc(announcementRevisions.version))
    .limit(limit);

  return rows.flatMap((row) => {
    if (row.scope !== 'site' && row.scope !== 'org' && row.scope !== 'project') return [];
    if (scope === 'org' && row.orgId !== orgId) return [];
    if (scope === 'site' && row.orgId !== null) return [];
    return [{
      id: row.id,
      scope: row.scope,
      title: row.title,
      body: row.body,
      version: row.version,
      authorDisplayName: row.authorDisplayName,
      authorKind: 'human' as const,
      clearedAt: row.clearedAt,
      createdAt: row.createdAt,
    }];
  });
}

type JoinedAnnouncement = {
  id: string;
  scope: string;
  orgId: string | null;
  title: string;
  body: string;
  version: number;
  clearedAt: Date | null;
  updatedAt: Date;
  authorDisplayName: string;
};

function toAnnouncement(row: JoinedAnnouncement): Announcement | null {
  if (row.clearedAt) return null;
  if (row.scope !== 'site' && row.scope !== 'org' && row.scope !== 'project') return null;
  return {
    id: row.id,
    scope: row.scope,
    title: row.title,
    body: row.body,
    version: row.version,
    authorDisplayName: row.authorDisplayName,
    authorKind: 'human',
    updatedAt: row.updatedAt,
  };
}

function requiredOrgId(orgId: string | null): string {
  if (!orgId) throw new DomainError('forbidden_or_not_found');
  return orgId;
}

function announcementState(row: { clearedAt: Date | null }): AnnouncementState {
  return row.clearedAt ? 'cleared' : 'active';
}

function resultOf(applied: Applied, scope: AnnouncementScope, cleared: boolean): AnnouncementMutationResult {
  return { id: applied.id, scope, version: applied.version, cleared };
}

function auditSnapshot(previous: Applied['previous']): { version: number; cleared: boolean } | null {
  if (!previous) return null;
  return { version: previous.version, cleared: previous.cleared };
}

/**
 * The principal flag is a hint from login. Admin removal must fail the next
 * publish of a principal that still says `siteAdmin: true`.
 */
async function assertCurrentSiteAdmin(tx: DbTx, userId: string): Promise<void> {
  const rows = await tx.select({ userId: siteAdmins.userId })
    .from(siteAdmins)
    .where(eq(siteAdmins.userId, userId))
    .limit(1)
    .for('update');
  if (!rows[0]) throw new DomainError('forbidden_or_not_found');
}

function assertHuman(principal: Principal): HumanPrincipal {
  if (principal.kind !== 'human') throw new DomainError('capability_denied');
  if (!principal.userId) throw new DomainError('validation_failed', { field: 'userId' });
  if (!principal.requestId) throw new DomainError('validation_failed', { field: 'requestId' });
  return principal;
}

function isUniqueViolation(error: unknown): boolean {
  return postgresCode(error) === '23505';
}

function mapLengthCheck(error: unknown): unknown {
  if (postgresCode(error) !== '23514') return error;
  const constraint = postgresConstraint(error) ?? '';
  if (constraint.endsWith('_title_len') || constraint.endsWith('_body_len')) {
    return new DomainError('content_too_large');
  }
  return error;
}

function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string' && /^\d{5}$/.test(record.code)) return record.code;
    current = record.cause;
  }
  return undefined;
}

function postgresConstraint(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
    const record = current as { constraint?: unknown; cause?: unknown };
    if (typeof record.constraint === 'string') return record.constraint;
    current = record.cause;
  }
  return undefined;
}

/** One selected project, with current grants checked in the kernel's transaction. */
export async function getProjectAnnouncement(principal: Principal, projectId: string, database?: AppDatabase): Promise<Announcement | null> {
  assertProjectId(projectId);
  return withOrgTx(principal, async (tx, ctx) => {
    await assertProjectAccess(tx, ctx.principal, projectId, 'read');
    return (await getProjectAnnouncementsInTx(tx, ctx, [projectId]))[0] ?? null;
  }, database ?? getDb());
}

/** Fixed query count. Selection and current grants constrain SQL before any body is read. */
export async function getProjectAnnouncementsInTx(tx: DbTx, ctx: TxContext, projectIds: string[]): Promise<Array<Announcement & { projectId: string }>> {
  const allowed = projectIds.filter((id) => ctx.projectIds === 'all' || ctx.projectIds.includes(id));
  if (!allowed.length) return [];
  const rows = await tx.select({
    id: announcements.id, scope: announcements.scope, orgId: announcements.orgId,
    projectId: announcements.projectId, title: announcements.title, body: announcements.body,
    version: announcements.version, clearedAt: announcements.clearedAt, updatedAt: announcements.updatedAt,
    authorDisplayName: user.name,
  }).from(announcements).innerJoin(user, eq(user.id, announcements.authorUserId))
    .where(and(eq(announcements.scope, 'project'), eq(announcements.orgId, ctx.orgId),
      inArray(announcements.projectId, allowed), isNull(announcements.clearedAt)));
  const byProject = new Map(rows.flatMap((row) => {
    const view = toAnnouncement(row);
    return view && row.projectId ? [[row.projectId, { ...view, projectId: row.projectId }] as const] : [];
  }));
  return allowed.flatMap((id) => byProject.has(id) ? [byProject.get(id)!] : []);
}

export async function listProjectAnnouncementRevisions(principal: Principal, input: { projectId: string; limit?: number }, database?: AppDatabase): Promise<AnnouncementRevision[]> {
  const human = assertHuman(principal);
  assertProjectId(input.projectId);
  const limit = assertRevisionLimit(input.limit);
  return withOrgTx(human, async (tx, ctx) => {
    if (ctx.role !== 'owner') throw new DomainError('capability_denied');
    await assertProjectAccess(tx, ctx.principal, input.projectId, 'read');
    return readRevisions(tx, 'project', ctx.orgId, limit, input.projectId);
  }, database ?? getDb());
}

export async function setProjectAnnouncement(principal: Principal, input: AnnouncementContentInput & { projectId: string }, database?: AppDatabase): Promise<AnnouncementMutationResult> {
  const human = assertHuman(principal);
  const content = assertAnnouncementContent(input.title, input.body);
  const expectedVersion = assertExpectedVersion(input.expectedVersion);
  assertProjectId(input.projectId);
  return mutateProject(human, { ...content, expectedVersion, projectId: input.projectId, mode: 'set' }, database);
}

export async function clearProjectAnnouncement(principal: Principal, input: AnnouncementVersionInput & { projectId: string }, database?: AppDatabase): Promise<AnnouncementMutationResult> {
  const human = assertHuman(principal);
  const expectedVersion = assertExpectedVersion(input.expectedVersion);
  assertProjectId(input.projectId);
  return mutateProject(human, { expectedVersion, projectId: input.projectId, mode: 'clear' }, database);
}

async function mutateProject(human: HumanPrincipal, input: { projectId: string; expectedVersion: number } & ({ mode: 'set'; title: string; body: string } | { mode: 'clear' }), database?: AppDatabase): Promise<AnnouncementMutationResult> {
  return withOrgTx(human, async (tx, ctx) => {
    if (ctx.role !== 'owner') throw new DomainError('capability_denied');
    // Read mode deliberately allows archived projects. No project row lock: concurrent first
    // publishes must race on the announcement index, like the site/org implementation.
    await assertProjectAccess(tx, ctx.principal, input.projectId, 'read');
    const applied = await applyMutation(tx, { ...input, scope: 'project', orgId: ctx.orgId, authorUserId: human.userId });
    const cleared = input.mode === 'clear';
    await writeAudit(tx, ctx, {
      action: cleared ? 'announcement.clear' : 'announcement.set', entityType: 'announcement', entityId: applied.id,
      before: applied.previous ? { ...applied.previous, projectId: input.projectId } : null,
      after: { version: applied.version, cleared, projectId: input.projectId },
    });
    return resultOf(applied, 'project', cleared);
  }, database ?? getDb());
}

function assertProjectId(id: string): void {
  if (!isUuid(id)) throw new DomainError('forbidden_or_not_found');
}
