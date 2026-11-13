import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, expect, test } from 'vitest';
import { closeDb } from '../../../src/db/client';
import { user } from '../../../src/db/schema/auth';
import { agentTokens } from '../../../src/db/schema/identity';
import { memberInvitations, orgMembers, organizations } from '../../../src/db/schema/org';
import { agentProjectDefaults } from '../../../src/db/schema/projects';
import { DomainError, newId, type HumanPrincipal } from '../../../src/domain/kernel';
import {
  createMemberInvite, consumeMemberInvite, listMembers, removeMember, revokeMemberInvite,
  setMemberCanCreateProjects,
} from '../../../src/domain/members';
import {
  associateOwner, consumeOwnerActivation, humanLanding, issueOwnerActivation, provisionOrganization,
} from '../../../src/domain/organizations';
import { setOrgAnnouncement, clearOrgAnnouncement, listAnnouncementRevisions } from '../../../src/domain/announcements';
import { listAuditLog } from '../../../src/domain/auditlog';
import {
  authenticateBearer, createToken, getConnectionDiagnostics, listAgents, listAgentSessions,
  listTokens, replaceToken, revokeToken, setAgentDefaults, setTokenGrants, setupAgentConnection,
} from '../../../src/domain/credentials';
import { postRoot, listThreads } from '../../../src/domain/messages';
import { archiveProject, createProject, restoreProject, setProjectVisibility, updateProject } from '../../../src/domain/projects';
import { siteAdmins } from '../../../src/db/schema/site-admins';
import { adminUrl, openDatabase, runtimeUrl, seedOrg } from '../helpers';

const admin = openDatabase(adminUrl(), 8);
process.env.DATABASE_URL = runtimeUrl();
const runtime = openDatabase(runtimeUrl(), 8);
afterAll(async () => { await closeDb(); await admin.pool.end(); await runtime.pool.end(); });

function ownerOf(seed: { userId: string; orgId: string }, requestId = newId()): HumanPrincipal {
  return { kind: 'human', userId: seed.userId, orgId: seed.orgId, role: 'owner', siteAdmin: false, interface: 'web', requestId };
}

async function verifiedUser(label: string) {
  const id = newId();
  const email = `${label}-${id}@example.com`;
  await admin.db.insert(user).values({ id, email, name: label, emailVerified: true });
  return { id, email };
}

async function addMember(owner: HumanPrincipal, person: { id: string; email: string }, canCreateProjects = false) {
  const invite = await createMemberInvite(owner, { email: person.email, canCreateProjects }, admin.db);
  const memberPrincipal: HumanPrincipal = {
    kind: 'human', userId: person.id, orgId: null, role: null, siteAdmin: false, interface: 'web', requestId: newId(),
  };
  await consumeMemberInvite(memberPrincipal, invite.token, admin.db);
  return {
    ...memberPrincipal,
    orgId: owner.orgId!,
    role: 'member' as const,
    requestId: newId(),
  };
}

test('member reads and posts in every project', async () => {
  const seed = await seedOrg(admin.db, 'm-read');
  const owner = ownerOf(seed);
  const second = await createProject(owner, { name: 'Beta', slug: 'beta', idempotencyKey: newId() });
  const person = await verifiedUser('reader');
  const member = await addMember(owner, person);
  const threads = await listThreads(member, { projectIds: [seed.projectId, second.id], status: 'active', sort: 'activity', limit: 10 });
  expect(threads.items).toEqual([]);
  const posted = await postRoot(member, {
    projectId: seed.projectId, title: 'Member note', body: 'hello', category: 'note',
    urgent: false, pinned: false, recipients: [], idempotencyKey: newId(),
  });
  expect(posted.title).toBe('Member note');
  const again = await listThreads(member, { projectIds: [seed.projectId], status: 'active', sort: 'activity', limit: 10 });
  expect(again.items.some((item) => item.id === posted.id)).toBe(true);
});

test('removed member fails on next domain call', async () => {
  const seed = await seedOrg(admin.db, 'm-remove-next');
  const owner = ownerOf(seed);
  const person = await verifiedUser('gone');
  const member = await addMember(owner, person);
  const [row] = await admin.db.select({ id: orgMembers.id }).from(orgMembers)
    .where(and(eq(orgMembers.orgId, seed.orgId), eq(orgMembers.userId, person.id)));
  await removeMember(owner, row!.id, admin.db);
  await expect(listThreads(member, { projectIds: [seed.projectId], status: 'active', sort: 'activity', limit: 5 }))
    .rejects.toMatchObject({ code: 'forbidden_or_not_found' });
});

test('owner-only operations deny members', async () => {
  const seed = await seedOrg(admin.db, 'm-deny');
  const owner = ownerOf(seed);
  const person = await verifiedUser('denied');
  const member = await addMember(owner, person, true);
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['archiveProject', () => archiveProject(member, seed.projectId)],
    ['restoreProject', () => restoreProject(member, seed.projectId)],
    ['updateProject', () => updateProject(member, seed.projectId, { name: 'Nope' })],
    ['setProjectVisibility', () => setProjectVisibility(member, seed.projectId, 'public')],
    ['setOrgAnnouncement', () => setOrgAnnouncement(member, { title: 'x', body: 'y', expectedVersion: 0 })],
    ['clearOrgAnnouncement', () => clearOrgAnnouncement(member, { expectedVersion: 0 })],
    ['listAnnouncementRevisions', () => listAnnouncementRevisions(member, { scope: 'org' })],
    ['listAuditLog', () => listAuditLog(member)],
    ['listAgents', () => listAgents(member)],
    ['listAgentSessions', () => listAgentSessions(member, seed.agentId)],
    ['setAgentDefaults', () => setAgentDefaults(member, seed.agentId, [seed.projectId])],
    ['createMemberInvite', () => createMemberInvite(member, { email: 'x@example.com', canCreateProjects: false })],
    ['listMembers', () => listMembers(member)],
  ];
  for (const [name, run] of cases) {
    try {
      await run();
      expect.fail(`${name} should deny`);
    } catch (error) {
      expect(error, name).toBeInstanceOf(DomainError);
      expect(['capability_denied', 'forbidden_or_not_found']).toContain((error as DomainError).code);
    }
  }
});

test('member lists only own tokens and foreign ids match absent', async () => {
  const seed = await seedOrg(admin.db, 'm-tokens');
  const owner = ownerOf(seed);
  const person = await verifiedUser('tokener');
  const member = await addMember(owner, person);
  const ownerToken = await createToken(owner, { label: 'owner-token', scope: 'org' });
  const mine = await createToken(member, { label: 'member-token', scope: 'org' });
  const listed = await listTokens(member);
  expect(listed.map((t) => t.id)).toEqual([mine.token.id]);
  const absent = newId();
  for (const id of [ownerToken.token.id, absent]) {
    await expect(revokeToken(member, id)).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
    await expect(replaceToken(member, id)).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
    await expect(setTokenGrants(member, id, [seed.projectId])).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
    await expect(getConnectionDiagnostics(member, { agentId: seed.agentId, tokenId: id }))
      .rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  }
});

test('member project creation and token flags', async () => {
  const seed = await seedOrg(admin.db, 'm-create');
  const owner = ownerOf(seed);
  const blockedPerson = await verifiedUser('blocked');
  const blocked = await addMember(owner, blockedPerson, false);
  await expect(createProject(blocked, { name: 'Nope', slug: 'nope', idempotencyKey: newId() }))
    .rejects.toMatchObject({ code: 'capability_denied' });
  await expect(createToken(blocked, { label: 'bad', scope: 'org', canCreateProjects: true }))
    .rejects.toMatchObject({ code: 'capability_denied' });
  const [blockedRow] = await admin.db.select({ id: orgMembers.id }).from(orgMembers)
    .where(and(eq(orgMembers.orgId, seed.orgId), eq(orgMembers.userId, blockedPerson.id)));
  await setMemberCanCreateProjects(owner, blockedRow!.id, true, admin.db);
  const unblocked: HumanPrincipal = { ...blocked, requestId: newId() };
  await createProject(unblocked, { name: 'Now', slug: 'now', idempotencyKey: newId() });
  const allowedPerson = await verifiedUser('allowed');
  const allowed = await addMember(owner, allowedPerson, true);
  const project = await createProject(allowed, { name: 'Yes', slug: 'yes', idempotencyKey: newId() });
  expect(project.slug).toBe('yes');
  const token = await createToken(allowed, { label: 'ok', scope: 'org', canCreateProjects: true });
  expect(token.token.canCreateProjects).toBe(true);
});

test('member connect wizard rejects existing agent names', async () => {
  const seed = await seedOrg(admin.db, 'm-connect');
  const owner = ownerOf(seed);
  await setupAgentConnection(owner, {
    agentName: 'shared-bot', token: { label: 'owner-conn', scope: 'org' }, defaultProjectIds: [seed.projectId],
  });
  const before = await admin.db.select().from(agentProjectDefaults)
    .where(and(eq(agentProjectDefaults.orgId, seed.orgId)));
  const person = await verifiedUser('connector');
  const member = await addMember(owner, person);
  await expect(setupAgentConnection(member, {
    agentName: 'shared-bot', token: { label: 'member-conn', scope: 'org' }, defaultProjectIds: [seed.projectId],
  })).rejects.toMatchObject({ code: 'validation_failed', details: { field: 'agentName' } });
  const after = await admin.db.select().from(agentProjectDefaults)
    .where(and(eq(agentProjectDefaults.orgId, seed.orgId)));
  expect(after).toEqual(before);
  const created = await setupAgentConnection(member, {
    agentName: 'member-bot', token: { label: 'member-new', scope: 'org' }, defaultProjectIds: [seed.projectId],
  });
  expect(created.agent.name).toBe('member-bot');
});

test('remove member revokes only that members tokens', async () => {
  const seed = await seedOrg(admin.db, 'm-revoke');
  const owner = ownerOf(seed);
  const a = await verifiedUser('rev-a');
  const b = await verifiedUser('rev-b');
  const memberA = await addMember(owner, a);
  const memberB = await addMember(owner, b);
  const ownerTok = await createToken(owner, { label: 'keep-owner', scope: 'org' });
  const aTok = await createToken(memberA, { label: 'drop-a', scope: 'org' });
  const bTok = await createToken(memberB, { label: 'keep-b', scope: 'org' });
  const [row] = await admin.db.select({ id: orgMembers.id }).from(orgMembers)
    .where(and(eq(orgMembers.orgId, seed.orgId), eq(orgMembers.userId, a.id)));
  await removeMember(owner, row!.id, admin.db);
  const [aRow] = await admin.db.select().from(agentTokens).where(eq(agentTokens.id, aTok.token.id));
  const [bRow] = await admin.db.select().from(agentTokens).where(eq(agentTokens.id, bTok.token.id));
  const [oRow] = await admin.db.select().from(agentTokens).where(eq(agentTokens.id, ownerTok.token.id));
  expect(aRow.revokedAt).not.toBeNull();
  expect(bRow.revokedAt).toBeNull();
  expect(oRow.revokedAt).toBeNull();
  await expect(authenticateBearer(`Bearer ${aTok.secret}`, { requestId: newId(), interface: 'mcp' }))
    .rejects.toMatchObject({ code: 'unauthenticated' });
});

test('invite consume rules under concurrency and rejection cases', async () => {
  const seed = await seedOrg(admin.db, 'm-invite');
  const owner = ownerOf(seed);
  const person = await verifiedUser('invitee');
  const first = await createMemberInvite(owner, { email: person.email, canCreateProjects: false }, admin.db);
  const second = await createMemberInvite(owner, { email: person.email, canCreateProjects: true }, admin.db);
  expect(createHash('sha256').update(first.token).digest('hex')).not.toBe(
    createHash('sha256').update(second.token).digest('hex'),
  );
  const [old] = await admin.db.select().from(memberInvitations)
    .where(eq(memberInvitations.tokenHash, createHash('sha256').update(first.token).digest('hex')));
  expect(old.revokedAt).not.toBeNull();

  const wrong = await verifiedUser('wrong');
  await expect(consumeMemberInvite({
    kind: 'human', userId: wrong.id, orgId: null, role: null, siteAdmin: false, interface: 'web', requestId: newId(),
  }, second.token, admin.db)).rejects.toMatchObject({ code: 'validation_failed' });

  await admin.db.update(memberInvitations).set({ expiresAt: new Date(0) })
    .where(eq(memberInvitations.tokenHash, createHash('sha256').update(second.token).digest('hex')));
  await expect(consumeMemberInvite({
    kind: 'human', userId: person.id, orgId: null, role: null, siteAdmin: false, interface: 'web', requestId: newId(),
  }, second.token, admin.db)).rejects.toMatchObject({ code: 'validation_failed' });

  const live = await createMemberInvite(owner, { email: person.email, canCreateProjects: false }, admin.db);
  await revokeMemberInvite(owner, (await listMembers(owner, admin.db)).invites[0]!.id, admin.db);
  await expect(consumeMemberInvite({
    kind: 'human', userId: person.id, orgId: null, role: null, siteAdmin: false, interface: 'web', requestId: newId(),
  }, live.token, admin.db)).rejects.toMatchObject({ code: 'validation_failed' });

  const concurrentPerson = await verifiedUser('race');
  const raceInvite = await createMemberInvite(owner, { email: concurrentPerson.email, canCreateProjects: false }, admin.db);
  const principal: HumanPrincipal = {
    kind: 'human', userId: concurrentPerson.id, orgId: null, role: null, siteAdmin: false, interface: 'web', requestId: newId(),
  };
  const results = await Promise.allSettled([
    consumeMemberInvite(principal, raceInvite.token, runtime.db),
    consumeMemberInvite({ ...principal, requestId: newId() }, raceInvite.token, runtime.db),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(await admin.db.select().from(orgMembers).where(eq(orgMembers.userId, concurrentPerson.id))).toHaveLength(1);

  const suspendedSeed = await seedOrg(admin.db, 'm-susp');
  const suspendedOwner = ownerOf(suspendedSeed);
  const suspPerson = await verifiedUser('susp');
  const suspInvite = await createMemberInvite(suspendedOwner, { email: suspPerson.email, canCreateProjects: false }, admin.db);
  await admin.db.update(organizations).set({ status: 'suspended' }).where(eq(organizations.id, suspendedSeed.orgId));
  await expect(consumeMemberInvite({
    kind: 'human', userId: suspPerson.id, orgId: null, role: null, siteAdmin: false, interface: 'web', requestId: newId(),
  }, suspInvite.token, admin.db)).rejects.toMatchObject({ code: 'validation_failed' });

  // Two orgs, two invites, same user: exactly one membership.
  const orgA = await seedOrg(admin.db, 'm-two-a');
  const orgB = await seedOrg(admin.db, 'm-two-b');
  const duel = await verifiedUser('duel');
  const inviteA = await createMemberInvite(ownerOf(orgA), { email: duel.email, canCreateProjects: false }, admin.db);
  const inviteB = await createMemberInvite(ownerOf(orgB), { email: duel.email, canCreateProjects: false }, admin.db);
  const duelPrincipal: HumanPrincipal = {
    kind: 'human', userId: duel.id, orgId: null, role: null, siteAdmin: false, interface: 'web', requestId: newId(),
  };
  const duelResults = await Promise.allSettled([
    consumeMemberInvite(duelPrincipal, inviteA.token, runtime.db),
    consumeMemberInvite({ ...duelPrincipal, requestId: newId() }, inviteB.token, runtime.db),
  ]);
  expect(duelResults.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(await admin.db.select().from(orgMembers).where(eq(orgMembers.userId, duel.id))).toHaveLength(1);
  expect(await admin.db.select().from(organizations).where(eq(organizations.ownerUserId, duel.id))).toHaveLength(0);

  // Already owning or belonging rejects.
  const belong = await verifiedUser('belong');
  await addMember(ownerOf(orgA), belong);
  const otherInvite = await createMemberInvite(ownerOf(orgB), { email: belong.email, canCreateProjects: false }, admin.db);
  await expect(consumeMemberInvite({
    kind: 'human', userId: belong.id, orgId: null, role: null, siteAdmin: false, interface: 'web', requestId: newId(),
  }, otherInvite.token, admin.db)).rejects.toMatchObject({ code: 'validation_failed' });
});

test('ownerByEmail and activation reject members', async () => {
  const seed = await seedOrg(admin.db, 'm-owner-gate');
  const owner = ownerOf(seed);
  const person = await verifiedUser('already-member');
  await addMember(owner, person);
  const adminUser = await verifiedUser('site-admin');
  await admin.db.insert(siteAdmins).values({ userId: adminUser.id });
  const adminPrincipal: HumanPrincipal = {
    kind: 'human', userId: adminUser.id, orgId: null, role: null, siteAdmin: true, interface: 'web', requestId: newId(),
  };
  const org = await provisionOrganization(adminPrincipal, { name: 'Other org' }, admin.db);
  await expect(associateOwner(adminPrincipal, org.id, person.email, admin.db))
    .rejects.toMatchObject({ code: 'validation_failed' });
  const activation = await issueOwnerActivation(adminPrincipal, org.id, person.email, admin.db);
  await expect(consumeOwnerActivation({
    kind: 'human', userId: person.id, orgId: null, role: null, siteAdmin: false, interface: 'web', requestId: newId(),
  }, activation.token, admin.db)).rejects.toMatchObject({ code: 'validation_failed' });
});

test('humanLanding treats members like owners', async () => {
  const seed = await seedOrg(admin.db, 'm-land');
  const owner = ownerOf(seed);
  const person = await verifiedUser('lander');
  const member = await addMember(owner, person);
  expect(await humanLanding(member, admin.db)).toBe('/');
  await admin.db.update(organizations).set({ status: 'suspended' }).where(eq(organizations.id, seed.orgId));
  expect(await humanLanding(member, admin.db)).toBe('/suspended');
});

test('member invite token is hashed and audit omits the secret', async () => {
  const seed = await seedOrg(admin.db, 'm-hash');
  const owner = ownerOf(seed);
  const person = await verifiedUser('hash');
  const invite = await createMemberInvite(owner, { email: person.email, canCreateProjects: false }, admin.db);
  const [stored] = await admin.db.select().from(memberInvitations).where(eq(memberInvitations.orgId, seed.orgId));
  expect(stored.tokenHash).toBe(createHash('sha256').update(invite.token).digest('hex'));
  expect(JSON.stringify(stored)).not.toContain(invite.token);
  const audits = await listAuditLog(owner, {}, admin.db);
  expect(JSON.stringify(audits)).not.toContain(invite.token);
  expect(audits.items.some((item) => item.action === 'member.invite')).toBe(true);
});
