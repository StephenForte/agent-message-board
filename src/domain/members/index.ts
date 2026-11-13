import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type AppDatabase, type DbTx } from '../../db/client';
import { user } from '../../db/schema/auth';
import { agentTokens } from '../../db/schema/identity';
import { memberInvitations, orgMembers, organizations } from '../../db/schema/org';
import {
  DomainError, appendEvents, isUuid, newId, requireTxOwner, withOrgBootstrapTx, withOrgTx, writeAudit,
  type HumanPrincipal, type Principal,
} from '../kernel';
import { requireOwner } from '../projects';

function invalid(reason: string): never { throw new DomainError('validation_failed', { reason }); }
function emailAddress(value: string) {
  const parsed = z.email().max(320).safeParse(value.trim().toLowerCase());
  if (!parsed.success) invalid('Enter a valid email address');
  return parsed.data;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const INVITE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

async function lockUser(tx: DbTx, userId: string) {
  const [row] = await tx.select().from(user).where(eq(user.id, userId)).for('update');
  if (!row) throw new DomainError('forbidden_or_not_found');
  return row;
}

async function assertNoOrgAffiliation(tx: DbTx, userId: string) {
  const [owned] = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.ownerUserId, userId));
  if (owned) invalid('This user already belongs to an organization');
  const [member] = await tx.select({ id: orgMembers.id }).from(orgMembers).where(eq(orgMembers.userId, userId));
  if (member) invalid('This user already belongs to an organization');
}

export async function createMemberInvite(
  principal: Principal,
  input: { email: string; canCreateProjects: boolean },
  database: AppDatabase = getDb(),
) {
  requireOwner(principal);
  if (typeof input.canCreateProjects !== 'boolean') throw new DomainError('validation_failed', { field: 'canCreateProjects' });
  const invitedEmail = emailAddress(input.email);
  return withOrgTx(principal, async (tx, ctx) => {
    requireTxOwner(ctx);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    // A newer invite for the same email in this org expires older pending ones.
    await tx.update(memberInvitations).set({ revokedAt: new Date() }).where(and(
      eq(memberInvitations.orgId, ctx.orgId),
      sql`lower(${memberInvitations.email}) = ${invitedEmail}`,
      isNull(memberInvitations.usedAt),
      isNull(memberInvitations.revokedAt),
    ));
    const id = newId();
    await tx.insert(memberInvitations).values({
      id, orgId: ctx.orgId, email: invitedEmail, tokenHash: digest(token),
      canCreateProjects: input.canCreateProjects, expiresAt, createdByUserId: principal.userId,
    });
    await writeAudit(tx, ctx, {
      action: 'member.invite', entityType: 'member_invitation', entityId: id,
      after: { email: invitedEmail, canCreateProjects: input.canCreateProjects, expiresAt: expiresAt.toISOString() },
    });
    return { token, expiresAt, email: invitedEmail, canCreateProjects: input.canCreateProjects };
  }, database);
}

export async function listMembers(principal: Principal, database: AppDatabase = getDb()) {
  requireOwner(principal);
  return withOrgTx(principal, async (tx, ctx) => {
    requireTxOwner(ctx);
    const [ownerRow] = await tx.select({
      userId: organizations.ownerUserId,
      email: user.email,
      name: user.name,
    }).from(organizations).leftJoin(user, eq(user.id, organizations.ownerUserId))
      .where(eq(organizations.id, ctx.orgId));
    const members = await tx.select({
      id: orgMembers.id,
      userId: orgMembers.userId,
      email: user.email,
      name: user.name,
      canCreateProjects: orgMembers.canCreateProjects,
      joinedAt: orgMembers.createdAt,
    }).from(orgMembers).innerJoin(user, eq(user.id, orgMembers.userId))
      .where(eq(orgMembers.orgId, ctx.orgId))
      .orderBy(asc(orgMembers.createdAt), asc(orgMembers.id));
    const invites = await tx.select({
      id: memberInvitations.id,
      email: memberInvitations.email,
      canCreateProjects: memberInvitations.canCreateProjects,
      expiresAt: memberInvitations.expiresAt,
      createdAt: memberInvitations.createdAt,
    }).from(memberInvitations).where(and(
      eq(memberInvitations.orgId, ctx.orgId),
      isNull(memberInvitations.usedAt),
      isNull(memberInvitations.revokedAt),
      sql`${memberInvitations.expiresAt} > now()`,
    )).orderBy(asc(memberInvitations.createdAt), asc(memberInvitations.id));
    return {
      owner: ownerRow?.userId ? {
        userId: ownerRow.userId,
        email: ownerRow.email ?? '',
        name: ownerRow.name ?? '',
      } : null,
      members: members.map((row) => ({
        ...row,
        joinedAt: row.joinedAt.toISOString(),
      })),
      invites: invites.map((row) => ({
        ...row,
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }, database);
}

export async function revokeMemberInvite(principal: Principal, inviteId: string, database: AppDatabase = getDb()) {
  requireOwner(principal);
  if (!isUuid(inviteId)) throw new DomainError('forbidden_or_not_found');
  return withOrgTx(principal, async (tx, ctx) => {
    requireTxOwner(ctx);
    const [row] = await tx.update(memberInvitations).set({ revokedAt: new Date() }).where(and(
      eq(memberInvitations.id, inviteId),
      eq(memberInvitations.orgId, ctx.orgId),
      isNull(memberInvitations.usedAt),
      isNull(memberInvitations.revokedAt),
    )).returning({ id: memberInvitations.id, email: memberInvitations.email });
    if (!row) throw new DomainError('forbidden_or_not_found');
    await writeAudit(tx, ctx, {
      action: 'member.invite_revoke', entityType: 'member_invitation', entityId: row.id,
      after: { email: row.email },
    });
    return { id: row.id };
  }, database);
}

export async function setMemberCanCreateProjects(
  principal: Principal,
  memberId: string,
  canCreateProjects: boolean,
  database: AppDatabase = getDb(),
) {
  requireOwner(principal);
  if (!isUuid(memberId)) throw new DomainError('forbidden_or_not_found');
  if (typeof canCreateProjects !== 'boolean') throw new DomainError('validation_failed', { field: 'canCreateProjects' });
  return withOrgTx(principal, async (tx, ctx) => {
    requireTxOwner(ctx);
    const [before] = await tx.select().from(orgMembers).where(and(
      eq(orgMembers.id, memberId), eq(orgMembers.orgId, ctx.orgId),
    )).for('update');
    if (!before) throw new DomainError('forbidden_or_not_found');
    const [after] = await tx.update(orgMembers).set({
      canCreateProjects, updatedAt: new Date(),
    }).where(eq(orgMembers.id, memberId)).returning();
    await writeAudit(tx, ctx, {
      action: 'member.update', entityType: 'org_member', entityId: memberId,
      before: { canCreateProjects: before.canCreateProjects },
      after: { canCreateProjects: after!.canCreateProjects },
    });
    return { id: memberId, canCreateProjects: after!.canCreateProjects };
  }, database);
}

export async function removeMember(principal: Principal, memberId: string, database: AppDatabase = getDb()) {
  requireOwner(principal);
  if (!isUuid(memberId)) throw new DomainError('forbidden_or_not_found');
  return withOrgTx(principal, async (tx, ctx) => {
    requireTxOwner(ctx);
    const [member] = await tx.select().from(orgMembers).where(and(
      eq(orgMembers.id, memberId), eq(orgMembers.orgId, ctx.orgId),
    )).for('update');
    if (!member) throw new DomainError('forbidden_or_not_found');
    const tokens = await tx.select({ id: agentTokens.id, revokedAt: agentTokens.revokedAt })
      .from(agentTokens).where(and(
        eq(agentTokens.orgId, ctx.orgId),
        eq(agentTokens.createdByUserId, member.userId),
        isNull(agentTokens.revokedAt),
      )).for('update');
    const revokedAt = new Date();
    for (const token of tokens) {
      await tx.update(agentTokens).set({ revokedAt, updatedAt: revokedAt }).where(eq(agentTokens.id, token.id));
      await appendEvents(tx, ctx.orgId, [{ kind: 'access.changed', entityType: 'credential', entityId: token.id }]);
      await writeAudit(tx, ctx, {
        action: 'credential.revoke', entityType: 'credential', entityId: token.id,
        before: { revokedAt: null }, after: { revokedAt: revokedAt.toISOString() },
      });
    }
    await tx.delete(orgMembers).where(eq(orgMembers.id, memberId));
    await appendEvents(tx, ctx.orgId, [{ kind: 'access.changed', entityType: 'org_member', entityId: memberId }]);
    await writeAudit(tx, ctx, {
      action: 'member.remove', entityType: 'org_member', entityId: memberId,
      before: { userId: member.userId, canCreateProjects: member.canCreateProjects },
      after: { revokedTokenCount: tokens.length },
    });
    return { id: memberId, revokedTokenCount: tokens.length };
  }, database);
}

export async function inspectMemberInvite(token: string, database: AppDatabase = getDb()) {
  if (!INVITE_TOKEN.test(token)) return null;
  const [row] = await database.select({
    email: memberInvitations.email,
    orgId: memberInvitations.orgId,
    orgName: organizations.name,
    orgStatus: organizations.status,
  }).from(memberInvitations)
    .innerJoin(organizations, eq(organizations.id, memberInvitations.orgId))
    .where(and(
      eq(memberInvitations.tokenHash, digest(token)),
      isNull(memberInvitations.usedAt),
      isNull(memberInvitations.revokedAt),
      sql`${memberInvitations.expiresAt} > now()`,
    ));
  if (!row || row.orgStatus !== 'active') return null;
  return { email: row.email, orgId: row.orgId, orgName: row.orgName };
}

export async function consumeMemberInvite(principal: Principal, token: string, database: AppDatabase = getDb()) {
  if (principal.kind !== 'human') throw new DomainError('forbidden_or_not_found');
  const invitation = await inspectMemberInvite(token, database);
  if (!invitation) invalid('Invitation link is invalid, expired, or already used');
  return withOrgBootstrapTx(invitation.orgId, async (tx) => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, invitation.orgId)).for('update');
    if (!org || org.status !== 'active') invalid('Invitation link is invalid, expired, or already used');
    const person = await lockUser(tx, principal.userId);
    if (!person.emailVerified || person.email.toLowerCase() !== invitation.email.toLowerCase()) {
      invalid('Sign in with the invited, verified email address');
    }
    await assertNoOrgAffiliation(tx, person.id);
    const [invite] = await tx.select().from(memberInvitations).where(and(
      eq(memberInvitations.tokenHash, digest(token)),
      eq(memberInvitations.orgId, org.id),
    )).for('update');
    if (!invite || invite.usedAt || invite.revokedAt || invite.expiresAt.getTime() <= Date.now()) {
      invalid('Invitation link is invalid, expired, or already used');
    }
    const [consumed] = await tx.update(memberInvitations).set({ usedAt: new Date() }).where(and(
      eq(memberInvitations.id, invite.id),
      isNull(memberInvitations.usedAt),
      isNull(memberInvitations.revokedAt),
      sql`${memberInvitations.expiresAt} > now()`,
      sql`lower(${memberInvitations.email}) = ${person.email.toLowerCase()}`,
    )).returning({ id: memberInvitations.id, canCreateProjects: memberInvitations.canCreateProjects });
    if (!consumed) invalid('Invitation link is invalid, expired, or already used');
    const memberId = newId();
    await tx.insert(orgMembers).values({
      id: memberId, orgId: org.id, userId: person.id, canCreateProjects: consumed.canCreateProjects,
    });
    const ctx = {
      principal, orgId: org.id, requestId: principal.requestId,
      projectIds: 'all' as const, canCreateProjects: consumed.canCreateProjects, role: 'member' as const,
    };
    await writeAudit(tx, ctx, {
      action: 'member.join', entityType: 'org_member', entityId: memberId,
      after: { userId: person.id, canCreateProjects: consumed.canCreateProjects },
    });
    return { id: org.id, memberId };
  }, database);
}

export type { HumanPrincipal };
