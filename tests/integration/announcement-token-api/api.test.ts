import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as schema from '../../../src/db/schema';
import { closeDb } from '../../../src/db/client';
import { PUT } from '../../../src/app/api/v1/projects/[projectSlug]/announcement/route';
import { authenticateBearer, connectAgent, createToken, replaceToken, resolveAgentSession, setupAgentConnection } from '../../../src/domain/credentials';
import { getPublicProjectAnnouncement, setProjectAnnouncement } from '../../../src/domain/announcements';
import { checkBoard } from '../../../src/domain/briefing';
import { newId, type HumanPrincipal } from '../../../src/domain/kernel';
import { RATE_LIMITS, checkRateLimit } from '../../../src/domain/ratelimit';
import { seedOrg } from '../helpers';
import { createProjectAnnouncementDatabase } from '../project-announcements/fixture';

let fixture: Awaited<ReturnType<typeof createProjectAnnouncementDatabase>>;
const previousDatabase = process.env.DATABASE_URL;
beforeAll(async () => {
  fixture = await createProjectAnnouncementDatabase();
  process.env.DATABASE_URL = fixture.runtime.pool.options.connectionString;
});
afterAll(async () => {
  await closeDb();
  await fixture?.cleanup();
  if (previousDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabase;
});
type Seed = Awaited<ReturnType<typeof seedOrg>>;
function owner(seed: Seed): HumanPrincipal {
  return { kind: 'human', userId: seed.userId, orgId: seed.orgId, role: 'owner', siteAdmin: false, requestId: newId(), interface: 'web' };
}
async function issued(seed: Seed, flag = true, restricted = false) {
  return createToken(owner(seed), { label: 'API writer', scope: restricted ? 'projects' : 'org',
    ...(restricted ? { projectIds: [seed.projectId] } : {}), canSetProjectAnnouncements: flag });
}
async function put(secret?: string, slug = 'alpha', input: unknown = { title: 'Snapshot', body: 'Reference data' }) {
  return PUT(new Request(`http://localhost/api/v1/projects/${slug}/announcement`, { method: 'PUT',
    headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), 'content-type': 'application/json' }, body: JSON.stringify(input),
  }), { params: Promise.resolve({ projectSlug: slug }) });
}
async function revisions(seed: Seed) {
  return fixture.admin.db.select().from(schema.announcementRevisions).where(eq(schema.announcementRevisions.orgId, seed.orgId));
}
async function member(seed: Seed) {
  const userId = newId();
  await fixture.admin.db.insert(schema.user).values({ id: userId, name: 'Member', email: `${userId}@example.test`, emailVerified: true });
  await fixture.admin.db.insert(schema.orgMembers).values({ id: newId(), orgId: seed.orgId, userId, canCreateProjects: true });
  return { ...owner(seed), userId, role: 'member' as const };
}

test('owner-issued token sets and replaces with two revisions, token audits and fresh check_board body', async () => {
  const seed = await seedOrg(fixture.admin.db, 'api-success');
  const token = await issued(seed);
  const responses = [];
  for (const body of ['Initial snapshot', 'Replacement snapshot']) {
    const response = await put(token.secret, 'alpha', { title: 'Snapshot', body });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    responses.push(await response.json());
  }
  expect(responses.map(r => r.version)).toEqual([1, 2]);
  expect(responses[1]).toEqual({ projectSlug: 'alpha', version: 2, updatedAt: expect.any(String) });
  expect(Number.isFinite(Date.parse(responses[1].updatedAt))).toBe(true);
  expect((await revisions(seed)).map(r => r.version).sort()).toEqual([1, 2]);
  const audits = await fixture.admin.db.select().from(schema.auditRecords).where(and(
    eq(schema.auditRecords.orgId, seed.orgId), eq(schema.auditRecords.action, 'announcement.set')));
  expect(audits).toHaveLength(2);
  expect(audits.every(r => r.tokenId === token.token.id && r.actorKind === 'agent' && r.userId === null)).toBe(true);
  expect(JSON.stringify(audits)).not.toContain('snapshot');
  const principal = await authenticateBearer(`Bearer ${token.secret}`, { requestId: newId(), interface: 'mcp' });
  const connected = await connectAgent(principal, { name: 'snapshot-reader' });
  const resolved = await resolveAgentSession(principal, connected.sessionId);
  const board = await checkBoard(resolved, { projectId: seed.projectId });
  expect(board.announcements.projects[0]?.body).toBe('Replacement snapshot');
});

test('missing capability is 403; foreign, ungranted and unknown slugs share a 404 and write nothing', async () => {
  const a = await seedOrg(fixture.admin.db, 'api-boundary-a');
  const b = await seedOrg(fixture.admin.db, 'api-boundary-b');
  await fixture.admin.db.update(schema.projects).set({ slug: 'foreign' }).where(eq(schema.projects.id, b.projectId));
  await fixture.admin.db.insert(schema.projects).values({ id: newId(), orgId: a.orgId, slug: 'hidden', name: 'Hidden', status: 'active', createdByKind: 'human', createdByUserId: a.userId });
  const restricted = await issued(a, true, true);
  const noFlag = await issued(a, false);
  const denied = await put(noFlag.secret);
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: { code: 'capability_denied' } });
  const misses = [];
  for (const slug of ['foreign', 'hidden', 'unknown']) {
    const response = await put(restricted.secret, slug);
    expect(response.status).toBe(404);
    misses.push(await response.json());
  }
  expect(misses).toEqual(Array(3).fill({ error: { code: 'forbidden_or_not_found' } }));
  expect(await revisions(a)).toHaveLength(0);
  expect(await revisions(b)).toHaveLength(0);
  expect((await put(restricted.secret)).status).toBe(200);
});

test('members cannot grant the flag on issue, replace or connect even with a forged owner hint', async () => {
  const seed = await seedOrg(fixture.admin.db, 'api-member');
  const m = await member(seed);
  const forged = { ...m, role: 'owner' as const };
  const token = await createToken(m, { label: 'Member token', scope: 'org' });
  expect(token.token.canSetProjectAnnouncements).toBe(false);
  for (const principal of [m, forged]) {
    await expect(createToken(principal, { label: 'No', scope: 'org', canSetProjectAnnouncements: true })).rejects.toMatchObject({ code: 'capability_denied' });
    await expect(replaceToken(principal, token.token.id, { canSetProjectAnnouncements: true })).rejects.toMatchObject({ code: 'capability_denied' });
    await expect(setupAgentConnection(principal, { agentName: 'no-flag', defaultProjectIds: [], token: { label: 'No', scope: 'org', canSetProjectAnnouncements: true } })).rejects.toMatchObject({ code: 'capability_denied' });
  }
  const replacement = await replaceToken(owner(seed), token.token.id, { canSetProjectAnnouncements: true });
  expect(replacement.token.canSetProjectAnnouncements).toBe(true);
  expect((await put(replacement.secret)).status).toBe(200);
  const disabled = await replaceToken(owner(seed), replacement.token.id, { canSetProjectAnnouncements: false });
  expect((await put(disabled.secret)).status).toBe(403);
});

test('a flagged token stops writing after ownership changes with no new revision', async () => {
  const seed = await seedOrg(fixture.admin.db, 'api-owner-change');
  const token = await issued(seed);
  expect((await put(token.secret)).status).toBe(200);
  const next = await member(seed);
  await fixture.admin.db.update(schema.organizations).set({ ownerUserId: next.userId }).where(eq(schema.organizations.id, seed.orgId));
  const denied = await put(token.secret);
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ error: { code: 'capability_denied' } });
  expect(await revisions(seed)).toHaveLength(1);
});

test('missing, malformed, revoked and expired bearer credentials return 401', async () => {
  const seed = await seedOrg(fixture.admin.db, 'api-lifecycle');
  expect((await put()).status).toBe(401);
  expect((await put('invalid')).status).toBe(401);
  for (const state of ['revoked', 'expired']) {
    const token = await issued(seed);
    await fixture.admin.db.update(schema.agentTokens).set(state === 'revoked' ? { revokedAt: new Date() } : { expiresAt: new Date(0) }).where(eq(schema.agentTokens.id, token.token.id));
    expect((await put(token.secret)).status).toBe(401);
  }
  expect(await revisions(seed)).toHaveLength(0);
});

test('invalid JSON shape and D-042 byte validation return 400 without revisions', async () => {
  const seed = await seedOrg(fixture.admin.db, 'api-validation');
  const token = await issued(seed);
  for (const [input, code] of [[null, 'validation_failed'], [[], 'validation_failed'], [{ title: 'x' }, 'validation_failed'], [{ title: '', body: '' }, 'content_too_large'], [{ title: 'x', body: 'é'.repeat(131072) + 'a' }, 'content_too_large']] as const) {
    const response = await put(token.secret, 'alpha', input);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code } });
  }
  const response = await PUT(new Request('http://localhost', { method: 'PUT', headers: { authorization: `Bearer ${token.secret}` }, body: '{' }), { params: Promise.resolve({ projectSlug: 'alpha' }) });
  expect(response.status).toBe(400);
  expect(await revisions(seed)).toHaveLength(0);
});

test('concurrent first writes all succeed and serialize consecutive last-write-wins versions', async () => {
  const seed = await seedOrg(fixture.admin.db, 'api-concurrent');
  const token = await issued(seed);
  const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => put(token.secret, 'alpha', { title: 'Concurrent', body: String(i) })));
  expect(responses.map(r => r.status)).toEqual(Array(6).fill(200));
  const results = await Promise.all(responses.map(r => r.json()));
  expect(results.map(r => r.version).sort()).toEqual([1, 2, 3, 4, 5, 6]);
  expect(await revisions(seed)).toHaveLength(6);
});

test('announcement and revision roll back when the token audit fails and internal errors stay private', async () => {
  const seed = await seedOrg(fixture.admin.db, 'api-rollback');
  const token = await issued(seed);
  await fixture.admin.pool.query(`CREATE FUNCTION t27_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'announcement.set' THEN RAISE EXCEPTION 'private-diagnostic'; END IF; RETURN NEW; END $$`);
  await fixture.admin.pool.query(`CREATE TRIGGER t27_reject_audit BEFORE INSERT ON audit_records FOR EACH ROW EXECUTE FUNCTION t27_reject_audit()`);
  try {
    const response = await put(token.secret);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'unavailable' } });
    expect(await revisions(seed)).toHaveLength(0);
    expect(await fixture.admin.db.select().from(schema.announcements).where(eq(schema.announcements.orgId, seed.orgId))).toHaveLength(0);
  } finally {
    await fixture.admin.pool.query('DROP TRIGGER t27_reject_audit ON audit_records');
    await fixture.admin.pool.query('DROP FUNCTION t27_reject_audit()');
  }
});

test('announcement bucket allows 30 per minute, returns Retry-After and isolates sibling tokens', async () => {
  const seed = await seedOrg(fixture.admin.db, 'api-limit');
  const token = await issued(seed), sibling = await issued(seed);
  expect(RATE_LIMITS.set_project_announcement).toBe(30);
  // Seed just below the ceiling using the same database clock as the limiter.
  await fixture.admin.pool.query(`insert into rate_limit_windows (org_id,token_id,bucket,window_start,count) values ($1,$2,'set_project_announcement',date_trunc('minute',clock_timestamp()),29)`, [seed.orgId, token.token.id]);
  expect((await put(token.secret)).status).toBe(200);
  const response = await put(token.secret);
  expect(response.status).toBe(429);
  expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
  expect((await put(sibling.secret)).status).toBe(200);
  const principal = await authenticateBearer(`Bearer ${token.secret}`, { requestId: newId(), interface: 'mcp' });
  await expect(checkRateLimit(principal, 'write')).resolves.toBeUndefined();
});

test('public reader exposes only project content and rejects private, unknown and suspended pages', async () => {
  const seed = await seedOrg(fixture.admin.db, 'api-public');
  const slug = 'public' + newId().replaceAll('-', '').slice(0, 10);
  await fixture.admin.db.update(schema.organizations).set({ slug }).where(eq(schema.organizations.id, seed.orgId));
  await setProjectAnnouncement(owner(seed), { projectId: seed.projectId, title: 'Project only', body: 'Public context', expectedVersion: 0 });
  await expect(getPublicProjectAnnouncement(slug, 'alpha')).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  await fixture.admin.db.update(schema.projects).set({ visibility: 'public' }).where(eq(schema.projects.id, seed.projectId));
  expect(await getPublicProjectAnnouncement(slug, 'alpha')).toMatchObject({ scope: 'project', title: 'Project only', body: 'Public context' });
  await expect(getPublicProjectAnnouncement(slug, 'missing')).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  await fixture.admin.db.update(schema.organizations).set({ status: 'suspended' }).where(eq(schema.organizations.id, seed.orgId));
  await expect(getPublicProjectAnnouncement(slug, 'alpha')).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
});
