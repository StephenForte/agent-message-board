import { eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as schema from '../../../src/db/schema/index';
import {
  clearOrgAnnouncement,
  clearSiteAnnouncement,
  getAnnouncements,
  getAnnouncementsInTx,
  listAnnouncementRevisions,
  setOrgAnnouncement,
  setSiteAnnouncement,
} from '../../../src/domain/announcements';
import { MAX_ANNOUNCEMENT_BYTES } from '../../../src/domain/announcements/content';
import { DomainError } from '../../../src/domain/kernel/errors';
import type { AgentPrincipal, HumanPrincipal } from '../../../src/domain/kernel/principal';
import { withOrgTx } from '../../../src/domain/kernel/tx';
import { createAnnouncementDatabase, seedOrg, seedSiteAdmin, type OrgSeed } from './fixture';

const viewKeys = ['authorDisplayName', 'authorKind', 'body', 'id', 'scope', 'title', 'updatedAt', 'version'];

let admin: Awaited<ReturnType<typeof createAnnouncementDatabase>>['admin'];
let runtime: Awaited<ReturnType<typeof createAnnouncementDatabase>>['runtime'];
let cleanup: () => Promise<void> = async () => {};
let home: OrgSeed;
let other: OrgSeed;
let versions: OrgSeed;
let suspended: OrgSeed;
let siteAdmin: { userId: string; userName: string };

beforeAll(async () => {
  const fixture = await createAnnouncementDatabase();
  admin = fixture.admin;
  runtime = fixture.runtime;
  cleanup = fixture.cleanup;
  home = await seedOrg(admin.db, 'home');
  other = await seedOrg(admin.db, 'other');
  versions = await seedOrg(admin.db, 'versions');
  suspended = await seedOrg(admin.db, 'suspended');
  siteAdmin = await seedSiteAdmin(admin.db, 'Site Admin');
  const client = new pg.Client({ connectionString: runtime.pool.options.connectionString });
  await client.connect();
  try {
    const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
    );
    expect(role.rows[0]?.rolsuper).toBe(false);
    expect(role.rows[0]?.rolbypassrls).toBe(false);
  } finally {
    await client.end();
  }
}, 30_000);

afterAll(async () => {
  await cleanup();
});

test('owner, org-wide token, and restricted token read site and org announcements and nothing about projects', async () => {
  await resetSite();
  const site = await setSiteAnnouncement(human(siteAdmin.userId, null, 'site-publish', true), {
    title: 'Site hello', body: 'for every org', expectedVersion: 0,
  }, runtime.db);
  expect(site).toMatchObject({ scope: 'site', version: 1, cleared: false });

  const org = await setOrgAnnouncement(owner(home, 'org-publish'), {
    title: 'Home note', body: 'home body', expectedVersion: 0,
  }, runtime.db);
  expect(org).toMatchObject({ scope: 'org', version: 1, cleared: false });

  const readers = [
    owner(home, 'read-owner'),
    orgToken(home, 'read-org'),
    restrictedToken(home, 'read-restricted'),
  ];
  for (const principal of readers) {
    const pair = await getAnnouncements(principal, runtime.db);
    expect(Object.keys(pair.site ?? {}).sort()).toEqual(viewKeys);
    expect(Object.keys(pair.org ?? {}).sort()).toEqual(viewKeys);
    expect(pair.site).toMatchObject({
      scope: 'site', title: 'Site hello', body: 'for every org', version: 1,
      authorDisplayName: siteAdmin.userName, authorKind: 'human',
    });
    expect(pair.org).toMatchObject({
      scope: 'org', title: 'Home note', version: 1,
      authorDisplayName: home.userName, authorKind: 'human',
    });
    expect(pair.site?.updatedAt).toBeInstanceOf(Date);
    const encoded = JSON.stringify(pair);
    expect(encoded).not.toContain(home.hiddenProjectId);
    expect(encoded).not.toContain(home.visibleProjectId);
  }

  const outside = await getAnnouncements(restrictedToken(other, 'read-other'), runtime.db);
  expect(outside.site?.title).toBe('Site hello');
  expect(outside.org).toBeNull();
  expect(JSON.stringify(outside)).not.toContain('Home note');
  expect(JSON.stringify(outside)).not.toContain(home.hiddenProjectId);

  const inTx = await withOrgTx(restrictedToken(home, 'read-intx'), (tx, ctx) => getAnnouncementsInTx(tx, ctx), runtime.db);
  const plain = await getAnnouncements(restrictedToken(home, 'read-plain'), runtime.db);
  expect(inTx).toEqual(plain);
});

test('agent principals cannot set or clear, and a non-admin cannot publish the site announcement', async () => {
  await resetSite();
  const before = await counts(home.orgId);
  const agent = orgToken(home, 'agent-write');
  await expect(setOrgAnnouncement(agent, { title: 'nope', body: 'nope', expectedVersion: 0 }, runtime.db))
    .rejects.toMatchObject({ code: 'capability_denied' });
  await expect(clearOrgAnnouncement(agent, { expectedVersion: 0 }, runtime.db))
    .rejects.toMatchObject({ code: 'capability_denied' });
  await expect(setSiteAnnouncement(agent, { title: 'nope', body: 'nope', expectedVersion: 0 }, runtime.db))
    .rejects.toMatchObject({ code: 'capability_denied' });
  await expect(clearSiteAnnouncement(agent, { expectedVersion: 0 }, runtime.db))
    .rejects.toMatchObject({ code: 'capability_denied' });
  await expect(listAnnouncementRevisions(agent, { scope: 'org' }, runtime.db))
    .rejects.toMatchObject({ code: 'capability_denied' });
  expect(await counts(home.orgId)).toEqual(before);
  expect(await siteRows()).toEqual([]);

  const liar = owner(home, 'not-admin');
  expect(liar.siteAdmin).toBe(true);
  await expect(setSiteAnnouncement(liar, { title: 'stolen', body: 'site', expectedVersion: 0 }, runtime.db))
    .rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  await expect(clearSiteAnnouncement(liar, { expectedVersion: 0 }, runtime.db))
    .rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  await expect(listAnnouncementRevisions(liar, { scope: 'site' }, runtime.db))
    .rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  expect(await siteRows()).toEqual([]);
});

test('removing site_admins fails the next publish while the principal still claims siteAdmin', async () => {
  await resetSite();
  const principal = human(siteAdmin.userId, null, 'admin-live', true);
  const published = await setSiteAnnouncement(principal, {
    title: 'Keep', body: 'until revoked', expectedVersion: 0,
  }, runtime.db);
  expect(published.version).toBe(1);
  await admin.db.delete(schema.siteAdmins).where(eq(schema.siteAdmins.userId, siteAdmin.userId));
  expect(principal.siteAdmin).toBe(true);
  await expect(setSiteAnnouncement({ ...principal, requestId: 'admin-revoked' }, {
    title: 'Changed', body: 'should not land', expectedVersion: 1,
  }, runtime.db)).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  await expect(clearSiteAnnouncement({ ...principal, requestId: 'admin-revoked-clear' }, {
    expectedVersion: 1,
  }, runtime.db)).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  const rows = await siteRows();
  expect(rows).toEqual([{ title: 'Keep', body: 'until revoked', version: 1, clearedAt: null }]);
  const audits = await admin.db.select({ id: schema.auditRecords.id }).from(schema.auditRecords)
    .where(eq(schema.auditRecords.entityId, published.id));
  expect(audits).toEqual([]);
  await admin.db.insert(schema.siteAdmins).values({ userId: siteAdmin.userId });
});

test('stale versions conflict, concurrent first publishes conflict, and clear keeps history', async () => {
  const actor = owner(versions, 'versions');
  const first = await setOrgAnnouncement(actor, {
    title: 'One', body: 'body-one', expectedVersion: 0,
  }, runtime.db);
  expect(first.version).toBe(1);
  await expect(setOrgAnnouncement({ ...actor, requestId: 'stale-set' }, {
    title: 'Stale', body: 'nope', expectedVersion: 0,
  }, runtime.db)).rejects.toMatchObject({
    code: 'version_conflict', details: { currentVersion: 1, state: 'active' },
  });
  const second = await setOrgAnnouncement({ ...actor, requestId: 'second' }, {
    title: 'Two', body: 'body-two', expectedVersion: 1,
  }, runtime.db);
  expect(second.version).toBe(2);
  await expect(clearOrgAnnouncement({ ...actor, requestId: 'stale-clear' }, { expectedVersion: 1 }, runtime.db))
    .rejects.toMatchObject({ code: 'version_conflict', details: { currentVersion: 2, state: 'active' } });
  const cleared = await clearOrgAnnouncement({ ...actor, requestId: 'clear' }, { expectedVersion: 2 }, runtime.db);
  expect(cleared).toMatchObject({ version: 3, cleared: true });

  const pair = await getAnnouncements(actor, runtime.db);
  expect(pair.org).toBeNull();
  const history = await listAnnouncementRevisions(actor, { scope: 'org' }, runtime.db);
  expect(history.map((row) => row.version)).toEqual([3, 2, 1]);
  expect(history[0]).toMatchObject({ title: 'Two', body: 'body-two', clearedAt: expect.any(Date), authorKind: 'human' });
  expect(history[1]?.clearedAt).toBeNull();
  expect(history[2]).toMatchObject({ title: 'One', body: 'body-one', version: 1 });

  const live = await admin.db.select({
    version: schema.announcements.version, clearedAt: schema.announcements.clearedAt,
  }).from(schema.announcements).where(eq(schema.announcements.orgId, versions.orgId));
  expect(live).toHaveLength(1);
  expect(live[0]?.version).toBe(3);
  expect(live[0]?.clearedAt).toBeInstanceOf(Date);

  const audits = await admin.db.select({
    action: schema.auditRecords.action,
    before: schema.auditRecords.before,
    after: schema.auditRecords.after,
    actorKind: schema.auditRecords.actorKind,
    userId: schema.auditRecords.userId,
  }).from(schema.auditRecords).where(eq(schema.auditRecords.orgId, versions.orgId));
  audits.sort((left, right) => {
    const leftVersion = (left.after as { version?: number } | null)?.version ?? 0;
    const rightVersion = (right.after as { version?: number } | null)?.version ?? 0;
    return leftVersion - rightVersion;
  });
  expect(audits).toEqual([
    expect.objectContaining({ action: 'announcement.set', actorKind: 'human', userId: versions.userId, before: null, after: { version: 1, cleared: false } }),
    expect.objectContaining({ action: 'announcement.set', actorKind: 'human', userId: versions.userId, before: { version: 1, cleared: false }, after: { version: 2, cleared: false } }),
    expect.objectContaining({ action: 'announcement.clear', actorKind: 'human', userId: versions.userId, before: { version: 2, cleared: false }, after: { version: 3, cleared: true } }),
  ]);
  expect(JSON.stringify(audits)).not.toContain('body-one');
  expect(JSON.stringify(audits)).not.toContain('body-two');
  const events = await admin.db.select({ seq: schema.events.seq }).from(schema.events)
    .where(eq(schema.events.orgId, versions.orgId));
  expect(events).toEqual([]);

  const republished = await setOrgAnnouncement({ ...actor, requestId: 'republish' }, {
    title: 'Four', body: '', expectedVersion: 3,
  }, runtime.db);
  expect(republished.version).toBe(4);
  expect((await getAnnouncements({ ...actor, requestId: 'read-four' }, runtime.db)).org).toMatchObject({
    title: 'Four', body: '', version: 4,
  });
});

test('two concurrent first publishes yield one success and one version_conflict', async () => {
  const actor = owner(other, 'race');
  const attempts = await Promise.allSettled([
    setOrgAnnouncement({ ...actor, requestId: 'race-a' }, { title: 'Alpha', body: 'a', expectedVersion: 0 }, runtime.db),
    setOrgAnnouncement({ ...actor, requestId: 'race-b' }, { title: 'Beta', body: 'b', expectedVersion: 0 }, runtime.db),
  ]);
  const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
  const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  const failure = rejected[0]?.status === 'rejected' ? rejected[0].reason : undefined;
  expect(failure).toBeInstanceOf(DomainError);
  expect(failure).toMatchObject({ code: 'version_conflict', details: { currentVersion: 1, state: 'active' } });
  const rows = await admin.db.select({
    title: schema.announcements.title, version: schema.announcements.version,
  }).from(schema.announcements).where(eq(schema.announcements.orgId, other.orgId));
  expect(rows).toEqual([{ title: expect.stringMatching(/^(Alpha|Beta)$/), version: 1 }]);
  const revisions = await admin.db.select({ version: schema.announcementRevisions.version })
    .from(schema.announcementRevisions).where(eq(schema.announcementRevisions.orgId, other.orgId));
  expect(revisions).toEqual([{ version: 1 }]);
  const audits = await admin.db.select({ id: schema.auditRecords.id }).from(schema.auditRecords)
    .where(eq(schema.auditRecords.orgId, other.orgId));
  expect(audits).toHaveLength(1);
});

test('oversize title or body is content_too_large and writes nothing', async () => {
  const actor = owner(suspended, 'oversize');
  await expect(clearOrgAnnouncement(actor, { expectedVersion: 0 }, runtime.db)).rejects.toMatchObject({
    code: 'version_conflict', details: { currentVersion: 0, state: null },
  });
  await expect(setOrgAnnouncement(actor, {
    title: '', body: 'empty title', expectedVersion: 0,
  }, runtime.db)).rejects.toMatchObject({ code: 'content_too_large' });
  await expect(setOrgAnnouncement({ ...actor, requestId: 'big-title' }, {
    title: 'é'.repeat((MAX_ANNOUNCEMENT_BYTES / 2) + 1), body: 'body', expectedVersion: 0,
  }, runtime.db)).rejects.toMatchObject({ code: 'content_too_large' });
  await expect(setSiteAnnouncement(human(siteAdmin.userId, null, 'big-site', true), {
    title: 'ok', body: 'b'.repeat(MAX_ANNOUNCEMENT_BYTES + 1), expectedVersion: 0,
  }, runtime.db)).rejects.toMatchObject({ code: 'content_too_large' });
  const exact = await setOrgAnnouncement({ ...actor, requestId: 'exact' }, {
    title: 'é'.repeat(MAX_ANNOUNCEMENT_BYTES / 2),
    body: 'b'.repeat(MAX_ANNOUNCEMENT_BYTES),
    expectedVersion: 0,
  }, runtime.db);
  expect(exact.version).toBe(1);
  expect(await counts(suspended.orgId)).toMatchObject({ announcements: 1, revisions: 1, audits: 1, events: 0 });
});

test('a suspended org rejects owner and agent reads', async () => {
  await admin.db.update(schema.organizations).set({ status: 'suspended' }).where(eq(schema.organizations.id, suspended.orgId));
  await expect(getAnnouncements(owner(suspended, 'suspended-owner'), runtime.db))
    .rejects.toMatchObject({ code: 'org_suspended' });
  await expect(getAnnouncements(restrictedToken(suspended, 'suspended-agent'), runtime.db))
    .rejects.toMatchObject({ code: 'org_suspended' });
  await admin.db.update(schema.organizations).set({ status: 'active' }).where(eq(schema.organizations.id, suspended.orgId));
});

test('site history is admin-only, has no audit row, and defaults to 20 revisions', async () => {
  await resetSite();
  const adminPrincipal = human(siteAdmin.userId, null, 'site-history', true);
  await setSiteAnnouncement(adminPrincipal, { title: 'S1', body: 'one', expectedVersion: 0 }, runtime.db);
  await setSiteAnnouncement({ ...adminPrincipal, requestId: 'site-2' }, { title: 'S2', body: 'two', expectedVersion: 1 }, runtime.db);
  const cleared = await clearSiteAnnouncement({ ...adminPrincipal, requestId: 'site-3' }, { expectedVersion: 2 }, runtime.db);
  expect(cleared.version).toBe(3);
  const history = await listAnnouncementRevisions(adminPrincipal, { scope: 'site' }, runtime.db);
  expect(history.map((row) => [row.version, row.title, row.clearedAt instanceof Date])).toEqual([
    [3, 'S2', true],
    [2, 'S2', false],
    [1, 'S1', false],
  ]);
  expect(await getAnnouncements(owner(home, 'site-cleared-read'), runtime.db)).toMatchObject({ site: null });
  const siteAudits = await admin.db.select({ id: schema.auditRecords.id }).from(schema.auditRecords)
    .where(eq(schema.auditRecords.entityId, cleared.id));
  expect(siteAudits).toEqual([]);

  const pageOrg = await seedOrg(admin.db, 'pages');
  const pager = owner(pageOrg, 'pager');
  for (let version = 0; version < 21; version += 1) {
    await setOrgAnnouncement({ ...pager, requestId: `page-${version}` }, {
      title: `P${version + 1}`, body: 'page', expectedVersion: version,
    }, runtime.db);
  }
  const defaults = await listAnnouncementRevisions(pager, { scope: 'org' }, runtime.db);
  expect(defaults).toHaveLength(20);
  expect(defaults[0]?.version).toBe(21);
  expect(defaults[19]?.version).toBe(2);
  const all = await listAnnouncementRevisions({ ...pager, requestId: 'page-all' }, { scope: 'org', limit: 100 }, runtime.db);
  expect(all).toHaveLength(21);
  const newest = await listAnnouncementRevisions({ ...pager, requestId: 'page-one' }, { scope: 'org', limit: 1 }, runtime.db);
  expect(newest.map((row) => row.version)).toEqual([21]);
  const pageAudits = await admin.db.select({ id: schema.auditRecords.id }).from(schema.auditRecords)
    .where(eq(schema.auditRecords.orgId, pageOrg.orgId));
  expect(pageAudits).toHaveLength(21);
  const pageEvents = await admin.db.select({ seq: schema.events.seq }).from(schema.events)
    .where(eq(schema.events.orgId, pageOrg.orgId));
  expect(pageEvents).toEqual([]);
});

function human(userId: string, orgId: string | null, requestId: string, siteAdminFlag: boolean): HumanPrincipal {
  return { kind: 'human', userId, orgId, role: orgId ? 'owner' : null, siteAdmin: siteAdminFlag, interface: 'web', requestId };
}

function owner(seed: OrgSeed, requestId: string): HumanPrincipal {
  return human(seed.userId, seed.orgId, requestId, true);
}

function orgToken(seed: OrgSeed, requestId: string): AgentPrincipal {
  return {
    kind: 'agent', orgId: seed.orgId, tokenId: seed.orgTokenId, scope: 'org', projectIds: 'all',
    canCreateProjects: false, agentId: null, sessionId: null, interface: 'mcp', requestId,
  };
}

function restrictedToken(seed: OrgSeed, requestId: string): AgentPrincipal {
  return {
    kind: 'agent', orgId: seed.orgId, tokenId: seed.restrictedTokenId, scope: 'projects',
    projectIds: [seed.visibleProjectId], canCreateProjects: false, agentId: null, sessionId: null,
    interface: 'mcp', requestId,
  };
}

async function resetSite(): Promise<void> {
  await admin.db.delete(schema.announcementRevisions).where(eq(schema.announcementRevisions.scope, 'site'));
  await admin.db.delete(schema.announcements).where(eq(schema.announcements.scope, 'site'));
}

async function siteRows(): Promise<Array<{ title: string; body: string; version: number; clearedAt: Date | null }>> {
  return admin.db.select({
    title: schema.announcements.title,
    body: schema.announcements.body,
    version: schema.announcements.version,
    clearedAt: schema.announcements.clearedAt,
  }).from(schema.announcements).where(eq(schema.announcements.scope, 'site'));
}

async function counts(orgId: string): Promise<{ announcements: number; revisions: number; audits: number; events: number }> {
  const announcements = await admin.db.select({ id: schema.announcements.id }).from(schema.announcements)
    .where(eq(schema.announcements.orgId, orgId));
  const revisions = await admin.db.select({ id: schema.announcementRevisions.id }).from(schema.announcementRevisions)
    .where(eq(schema.announcementRevisions.orgId, orgId));
  const audits = await admin.db.select({ id: schema.auditRecords.id }).from(schema.auditRecords)
    .where(eq(schema.auditRecords.orgId, orgId));
  const events = await admin.db.select({ seq: schema.events.seq }).from(schema.events)
    .where(eq(schema.events.orgId, orgId));
  return { announcements: announcements.length, revisions: revisions.length, audits: audits.length, events: events.length };
}
