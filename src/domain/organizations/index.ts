import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, type AppDatabase, type DbTx } from '../../db/client';
import { user } from '../../db/schema/auth';
import { orgMembers, organizations, ownerActivations } from '../../db/schema/org';
import { siteAdmins } from '../../db/schema/site-admins';
import { DomainError, isUuid, newId, withOrgBootstrapTx, withSiteAdminTx, writeAudit,
  type HumanPrincipal, type Principal, type AuditRecord, type TxContext } from '../kernel';
import { parseOrganizationSlug } from './slug';

function invalid(reason: string): never { throw new DomainError('validation_failed', { reason }); }
function emailAddress(value: string) {
  const parsed = z.email().max(320).safeParse(value.trim().toLowerCase());
  if (!parsed.success) invalid('Enter a valid email address');
  return parsed.data;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export async function assertSiteAdmin(tx: DbTx, principal: Principal | null): Promise<HumanPrincipal> {
  if (!principal || principal.kind !== 'human') throw new DomainError('forbidden_or_not_found');
  const [admin] = await tx.select({ id: siteAdmins.userId }).from(siteAdmins)
    .innerJoin(user, eq(user.id, siteAdmins.userId))
    .where(and(eq(siteAdmins.userId, principal.userId), eq(user.emailVerified, true))).for('share', { of: siteAdmins });
  if (!admin) throw new DomainError('forbidden_or_not_found');
  return principal;
}

/** D-023: all targeted admin mutations recheck the role and audit inside this transaction. */
async function withAdminOrganizationTx<T>(principal: Principal, orgId: string,
  fn: (tx: DbTx) => Promise<{ result: T; audit: AuditRecord }>, database: AppDatabase) {
  if (!isUuid(orgId)) throw new DomainError('forbidden_or_not_found');
  return withOrgBootstrapTx(orgId, async (tx) => {
    const admin = await assertSiteAdmin(tx, principal);
    const { result, audit } = await fn(tx);
    const ctx: TxContext = { principal: admin, orgId, requestId: admin.requestId,
      projectIds: [], canCreateProjects: false, role: null };
    await writeAudit(tx, ctx, audit);
    return result;
  }, database);
}

async function lockOrg(tx: DbTx, id: string) {
  const [org] = await tx.select().from(organizations).where(eq(organizations.id, id)).for('update');
  if (!org) throw new DomainError('forbidden_or_not_found');
  return org;
}
async function ownerByEmail(tx: DbTx, email: string, orgId: string) {
  // Lock the user to serialize assignments across different organizations.
  const [owner] = await tx.select().from(user).where(sql`lower(${user.email}) = ${emailAddress(email)}`).for('update');
  if (!owner?.emailVerified) invalid('Owner must be an existing verified user');
  const [existing] = await tx.select({ id: organizations.id }).from(organizations)
    .where(eq(organizations.ownerUserId, owner.id));
  if (existing && existing.id !== orgId) invalid('This user already owns an organization');
  const [membership] = await tx.select({ id: orgMembers.id }).from(orgMembers).where(eq(orgMembers.userId, owner.id));
  if (membership) invalid('This user already belongs to an organization');
  return owner;
}

export async function provisionOrganization(principal: Principal, input: { name: string; ownerEmail?: string }, database = getDb()) {
  const orgId = newId();
  return withAdminOrganizationTx(principal, orgId, async (tx) => {
    const name = input.name.trim();
    if (!name || [...name].length > 200) invalid('Organization name must be 1–200 characters');
    const owner = input.ownerEmail ? await ownerByEmail(tx, input.ownerEmail, orgId) : null;
    const [org] = await tx.insert(organizations).values({ id: orgId, name, ownerUserId: owner?.id ?? null, status: 'active' }).returning();
    return { result: org!, audit: { action: 'organization.provision', entityType: 'organization', entityId: orgId,
      after: { name, status: 'active', ownerUserId: owner?.id ?? null } } };
  }, database);
}

export async function associateOwner(principal: Principal, orgId: string, email: string, database = getDb()) {
  return withAdminOrganizationTx(principal, orgId, async (tx) => {
    const org = await lockOrg(tx, orgId);
    const owner = await ownerByEmail(tx, email, orgId);
    await tx.update(organizations).set({ ownerUserId: owner.id, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    // Existing invitations must not overwrite a later explicit owner association.
    await tx.update(ownerActivations).set({ usedAt: new Date() }).where(and(eq(ownerActivations.orgId, orgId), isNull(ownerActivations.usedAt)));
    return { result: { id: orgId }, audit: { action: 'organization.associate_owner', entityType: 'organization', entityId: orgId,
      before: { ownerUserId: org.ownerUserId }, after: { ownerUserId: owner.id } } };
  }, database);
}

export async function issueOwnerActivation(principal: Principal, orgId: string, email: string, database = getDb()) {
  return withAdminOrganizationTx(principal, orgId, async (tx) => {
    const org = await lockOrg(tx, orgId);
    if (org.ownerUserId) invalid('Organization already has an owner');
    const invitedEmail = emailAddress(email);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    await tx.update(ownerActivations).set({ usedAt: new Date() }).where(and(eq(ownerActivations.orgId, orgId), isNull(ownerActivations.usedAt)));
    await tx.insert(ownerActivations).values({ id: newId(), orgId, email: invitedEmail, tokenHash: digest(token),
      expiresAt, createdByUserId: (principal as HumanPrincipal).userId });
    return { result: { token, expiresAt }, audit: { action: 'organization.issue_activation', entityType: 'organization', entityId: orgId,
      after: { email: invitedEmail, expiresAt: expiresAt.toISOString() } } };
  }, database);
}

export async function inspectOwnerActivation(token: string, database = getDb()) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [row] = await database.select({ email: ownerActivations.email, orgId: ownerActivations.orgId }).from(ownerActivations)
    .where(and(eq(ownerActivations.tokenHash, digest(token)), isNull(ownerActivations.usedAt), sql`${ownerActivations.expiresAt} > now()`));
  return row ?? null;
}

export async function consumeOwnerActivation(principal: Principal, token: string, database = getDb()) {
  if (principal.kind !== 'human') throw new DomainError('forbidden_or_not_found');
  const invitation = await inspectOwnerActivation(token, database);
  if (!invitation) invalid('Activation link is invalid, expired, or already used');
  return withOrgBootstrapTx(invitation.orgId, async (tx) => {
    const org = await lockOrg(tx, invitation.orgId);
    if (org.ownerUserId) invalid('Organization already has an owner');
    const [owner] = await tx.select().from(user).where(eq(user.id, principal.userId)).for('update');
    if (!owner?.emailVerified || owner.email.toLowerCase() !== invitation.email.toLowerCase()) {
      invalid('Sign in with the invited, verified email address');
    }
    const [existing] = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.ownerUserId, owner.id));
    if (existing) invalid('This user already owns an organization');
    const [membership] = await tx.select({ id: orgMembers.id }).from(orgMembers).where(eq(orgMembers.userId, owner.id));
    if (membership) invalid('This user already belongs to an organization');
    // Single conditional write, within the same transaction as owner assignment.
    const [consumed] = await tx.update(ownerActivations).set({ usedAt: new Date() }).where(and(
      eq(ownerActivations.tokenHash, digest(token)), eq(ownerActivations.orgId, org.id),
      sql`lower(${ownerActivations.email}) = ${owner.email.toLowerCase()}`,
      isNull(ownerActivations.usedAt), sql`${ownerActivations.expiresAt} > now()`,
    )).returning({ id: ownerActivations.id });
    if (!consumed) invalid('Activation link is invalid, expired, or already used');
    await tx.update(organizations).set({ ownerUserId: owner.id, updatedAt: new Date() }).where(eq(organizations.id, org.id));
    await writeAudit(tx, { principal, orgId: org.id, requestId: principal.requestId, projectIds: [], canCreateProjects: false, role: null }, {
      action: 'organization.consume_activation', entityType: 'organization', entityId: org.id, after: { ownerUserId: owner.id },
    });
    return { id: org.id };
  }, database);
}

async function setStatus(principal: Principal, orgId: string, status: 'active' | 'suspended', database: AppDatabase) {
  return withAdminOrganizationTx(principal, orgId, async (tx) => {
    const org = await lockOrg(tx, orgId);
    await tx.update(organizations).set({ status, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    return { result: { id: orgId }, audit: { action: status === 'active' ? 'organization.restore' : 'organization.suspend',
      entityType: 'organization', entityId: orgId, before: { status: org.status }, after: { status } } };
  }, database);
}
function constraintCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    if ('code' in current && current.code === code) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/** Site admin only. Audited into the target org. Agents and owners who are not site admins cannot set it. */
export async function setOrganizationSlug(principal: Principal, orgId: string, slug: string, database = getDb()) {
  const next = parseOrganizationSlug(slug);
  return withAdminOrganizationTx(principal, orgId, async (tx) => {
    const org = await lockOrg(tx, orgId);
    if (org.slug === next) {
      return { result: { id: orgId, slug: next }, audit: { action: 'organization.set_slug', entityType: 'organization', entityId: orgId,
        before: { slug: org.slug }, after: { slug: next } } };
    }
    try {
      await tx.update(organizations).set({ slug: next, updatedAt: new Date() }).where(eq(organizations.id, orgId));
    } catch (error) {
      if (constraintCode(error, '23505')) {
        throw new DomainError('validation_failed', { field: 'slug', reason: 'That public address is already in use.' });
      }
      if (constraintCode(error, '23514')) {
        throw new DomainError('validation_failed', { field: 'slug', reason: 'That public address is not allowed.' });
      }
      throw error;
    }
    return { result: { id: orgId, slug: next }, audit: { action: 'organization.set_slug', entityType: 'organization', entityId: orgId,
      before: { slug: org.slug }, after: { slug: next } } };
  }, database);
}

export async function suspendOrganization(principal: Principal, orgId: string, database = getDb()) {
  return setStatus(principal, orgId, 'suspended', database);
}
export async function restoreOrganization(principal: Principal, orgId: string, database = getDb()) {
  return setStatus(principal, orgId, 'active', database);
}
export async function listOrganizationsForAdmin(principal: Principal | null, database = getDb()) {
  return withSiteAdminTx(async (tx) => {
    await assertSiteAdmin(tx, principal);
    return tx.select({ id: organizations.id, name: organizations.name, status: organizations.status,
      slug: organizations.slug, ownerEmail: user.email, createdAt: organizations.createdAt }).from(organizations)
      .leftJoin(user, eq(user.id, organizations.ownerUserId)).orderBy(desc(organizations.createdAt), organizations.id);
  }, database);
}
export async function humanLanding(principal: HumanPrincipal, database = getDb()) {
  const [owned] = await database.select({ status: organizations.status }).from(organizations)
    .where(eq(organizations.ownerUserId, principal.userId));
  if (owned) return owned.status === 'suspended' ? '/suspended' : '/';
  const [membership] = await database.select({ status: organizations.status })
    .from(orgMembers).innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
    .where(eq(orgMembers.userId, principal.userId)).limit(1);
  return !membership ? '/no-organization' : membership.status === 'suspended' ? '/suspended' : '/';
}
