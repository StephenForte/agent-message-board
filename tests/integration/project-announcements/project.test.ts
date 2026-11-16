import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as schema from '../../../src/db/schema';
import type { AppDatabase } from '../../../src/db/client';
import { clearProjectAnnouncement, getAnnouncements, getProjectAnnouncement, getProjectAnnouncementsInTx,
  listProjectAnnouncementRevisions, setOrgAnnouncement, setProjectAnnouncement } from '../../../src/domain/announcements';
import { checkBoard, renderBoardMarkdown } from '../../../src/domain/briefing';
import { sign } from '../../../src/domain/briefing/cursor';
import { newId, withOrgTx, type HumanPrincipal } from '../../../src/domain/kernel';
import { setLocal } from '../../../src/domain/kernel/tx';
import { agentPrincipal, seedOrg } from '../helpers';
import { createProjectAnnouncementDatabase } from './fixture';

let fixture: Awaited<ReturnType<typeof createProjectAnnouncementDatabase>>;
let admin: typeof fixture.admin;
let runtime: typeof fixture.runtime;
type Seed = Awaited<ReturnType<typeof seedOrg>>;
const previousDatabase = process.env.DATABASE_URL;
const previousSecret = process.env.CURSOR_HMAC_SECRET;
beforeAll(async () => {
  fixture = await createProjectAnnouncementDatabase();
  ({ admin, runtime } = fixture);
  process.env.DATABASE_URL = runtime.pool.options.connectionString;
  process.env.CURSOR_HMAC_SECRET = 't26-synthetic-signing-key-at-least-32-characters';
});
afterAll(async () => {
  await fixture?.cleanup();
  if (previousDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousDatabase;
  if (previousSecret === undefined) delete process.env.CURSOR_HMAC_SECRET; else process.env.CURSOR_HMAC_SECRET = previousSecret;
});
function owner(seed: Seed): HumanPrincipal {
  return { kind: 'human', orgId: seed.orgId, userId: seed.userId, role: 'owner', siteAdmin: false, interface: 'web', requestId: newId() };
}
async function project(seed: Seed, slug: string) {
  const id = newId();
  await admin.db.insert(schema.projects).values({ id, orgId: seed.orgId, slug, name: slug, status: 'active', createdByKind: 'human', createdByUserId: seed.userId });
  return id;
}
async function publish(seed: Seed, projectId = seed.projectId, body = 'Project body') {
  return setProjectAnnouncement(owner(seed), { projectId, title: 'Project news', body, expectedVersion: 0 }, runtime.db);
}
async function counts(seed: Seed) {
  return Promise.all([schema.announcements, schema.announcementRevisions, schema.auditRecords, schema.events].map(async (table) =>
    (await admin.db.select({ id: table.orgId }).from(table).where(eq(table.orgId, seed.orgId))).length));
}
async function member(seed: Seed) {
  const userId = newId();
  await admin.db.insert(schema.user).values({ id: userId, name: 'Member', email: `${userId}@example.com`, emailVerified: true });
  await admin.db.insert(schema.orgMembers).values({ id: newId(), orgId: seed.orgId, userId });
  return { ...owner(seed), userId, role: 'member' as const };
}

test('project versions and history are independent across projects, orgs and org announcements', async () => {
  const a = await seedOrg(admin.db, 't26-independent-a');
  const b = await seedOrg(admin.db, 't26-independent-b');
  const second = await project(a, 'second');
  for (const [seed, id] of [[a, a.projectId], [a, second], [b, b.projectId]] as const) {
    expect(await publish(seed, id)).toMatchObject({ version: 1, scope: 'project', cleared: false });
    expect((await listProjectAnnouncementRevisions(owner(seed), { projectId: id }, runtime.db)).map((row) => row.version)).toEqual([1]);
  }
  expect(await setOrgAnnouncement(owner(a), { title: 'Org news', body: 'Org body', expectedVersion: 0 }, runtime.db)).toMatchObject({ version: 1 });
  const before = await counts(a);
  await expect(setProjectAnnouncement(owner(a), { projectId: a.projectId, title: 'Stale', body: 'Do not persist', expectedVersion: 0 }, runtime.db))
    .rejects.toMatchObject({ code: 'version_conflict', details: { currentVersion: 1, state: 'active' } });
  expect(await counts(a)).toEqual(before);
  await clearProjectAnnouncement(owner(a), { projectId: a.projectId, expectedVersion: 1 }, runtime.db);
  expect(await getProjectAnnouncement(owner(a), a.projectId, runtime.db)).toBeNull();
  await expect(publish(a)).rejects.toMatchObject({ code: 'version_conflict', details: { currentVersion: 2, state: 'cleared' } });
  await setProjectAnnouncement(owner(a), { projectId: a.projectId, title: 'Again', body: '', expectedVersion: 2 }, runtime.db);
  expect((await listProjectAnnouncementRevisions(owner(a), { projectId: a.projectId }, runtime.db)).map((row) => row.version)).toEqual([3, 2, 1]);
  expect((await listProjectAnnouncementRevisions(owner(a), { projectId: second }, runtime.db)).map((row) => row.version)).toEqual([1]);
  const pair = await getAnnouncements(owner(a), runtime.db);
  expect(Object.keys(pair)).toEqual(['site', 'org']);
  expect(pair.org?.title).toBe('Org news');
  const audits = await admin.db.select().from(schema.auditRecords).where(and(eq(schema.auditRecords.orgId, a.orgId), eq(schema.auditRecords.entityType, 'announcement')));
  const projectAudits = audits.filter((row) => (row.after as { projectId?: string })?.projectId === a.projectId);
  projectAudits.sort((a, b) => (a.after as { version: number }).version - (b.after as { version: number }).version);
  expect(projectAudits.map((row) => row.after)).toEqual([
    { version: 1, cleared: false, projectId: a.projectId }, { version: 2, cleared: true, projectId: a.projectId }, { version: 3, cleared: false, projectId: a.projectId },
  ]);
  expect(projectAudits.map((row) => row.before)).toEqual([null, { version: 1, cleared: false, projectId: a.projectId }, { version: 2, cleared: true, projectId: a.projectId }]);
  expect(JSON.stringify(audits)).not.toContain('Project body');
  expect((await counts(a))[3]).toBe(0);
});

test('only the current owner edits; foreign ids write nothing; archived projects allow set and clear', async () => {
  const a = await seedOrg(admin.db, 't26-auth-a');
  const b = await seedOrg(admin.db, 't26-auth-b');
  const m = await member(a);
  const before = await counts(a);
  for (const actor of [m, agentPrincipal(a), { kind: 'system' as const, orgId: a.orgId, interface: 'cli' as const, requestId: newId() }]) {
    await expect(setProjectAnnouncement(actor, { projectId: a.projectId, title: 'No', body: '', expectedVersion: 0 }, runtime.db)).rejects.toMatchObject({ code: 'capability_denied' });
    await expect(clearProjectAnnouncement(actor, { projectId: a.projectId, expectedVersion: 0 }, runtime.db)).rejects.toMatchObject({ code: 'capability_denied' });
    await expect(listProjectAnnouncementRevisions(actor, { projectId: a.projectId }, runtime.db)).rejects.toMatchObject({ code: 'capability_denied' });
  }
  // A pool that must never be touched proves non-human rejection happens before a transaction.
  const noDb = new Proxy({} as AppDatabase, { get() { throw new Error('opened database'); } });
  await expect(async () => setProjectAnnouncement(agentPrincipal(a), { projectId: a.projectId, title: 'No', body: '', expectedVersion: 0 }, noDb)).rejects.toMatchObject({ code: 'capability_denied' });
  for (const id of [a.projectId, newId()]) {
    await expect(setProjectAnnouncement(owner(b), { projectId: id, title: 'No', body: '', expectedVersion: 0 }, runtime.db)).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
    await expect(clearProjectAnnouncement(owner(b), { projectId: id, expectedVersion: 0 }, runtime.db)).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
    await expect(getProjectAnnouncement(owner(b), id, runtime.db)).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  }
  expect(await counts(a)).toEqual(before);
  expect(await counts(b)).toEqual([0, 0, 0, 0]);
  await admin.db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, a.projectId));
  await publish(a);
  expect((await getProjectAnnouncement(m, a.projectId, runtime.db))?.version).toBe(1);
  await clearProjectAnnouncement(owner(a), { projectId: a.projectId, expectedVersion: 1 }, runtime.db);
});

test('project limits and history default 20 maximum 100 match organization semantics', async () => {
  const seed = await seedOrg(admin.db, 't26-limits');
  for (const [title, body] of [['', ''], ['é'.repeat(8193), ''], ['ok', 'x'.repeat(262145)]]) {
    await expect(setProjectAnnouncement(owner(seed), { projectId: seed.projectId, title: title!, body: body!, expectedVersion: 0 }, runtime.db)).rejects.toMatchObject({ code: 'content_too_large' });
  }
  expect(await counts(seed)).toEqual([0, 0, 0, 0]);
  for (let expectedVersion = 0; expectedVersion < 21; expectedVersion++) {
    await setProjectAnnouncement(owner(seed), { projectId: seed.projectId, title: 'é'.repeat(8192), body: 'x'.repeat(262144), expectedVersion }, runtime.db);
  }
  expect(await listProjectAnnouncementRevisions(owner(seed), { projectId: seed.projectId }, runtime.db)).toHaveLength(20);
  expect(await listProjectAnnouncementRevisions(owner(seed), { projectId: seed.projectId, limit: 100 }, runtime.db)).toHaveLength(21);
  await expect(listProjectAnnouncementRevisions(owner(seed), { projectId: seed.projectId, limit: 101 }, runtime.db)).rejects.toMatchObject({ code: 'validation_failed' });
});

test('concurrent first publish waits on an uncommitted rival and maps only the live-row unique index', async () => {
  const seed = await seedOrg(admin.db, 't26-race');
  let release!: () => void;
  let armed!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { armed = resolve; });
  const blockedDatabase = new Proxy(runtime.db, {
    get(target, key) {
      if (key !== 'transaction') return Reflect.get(target, key);
      return (fn: Parameters<AppDatabase['transaction']>[0]) => target.transaction(async (tx) => {
        const session = (tx as unknown as { session: { client: import('pg').PoolClient } }).session;
        const original = session.client;
        session.client = new Proxy(original, { get(client, field) {
          if (field !== 'query') return Reflect.get(client, field);
          return async (...args: unknown[]) => {
            const query = typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text;
            const result: unknown = await Reflect.apply(client.query, client, args);
            if (query.startsWith('insert into "announcements"')) { armed(); await held; }
            return result;
          };
        } });
        try { return await fn(tx); } finally { session.client = original; }
      });
    },
  });
  const winner = setProjectAnnouncement(owner(seed), { projectId: seed.projectId, title: 'Winner', body: '', expectedVersion: 0 }, blockedDatabase);
  await ready;
  const loser = publish(seed);
  const settledLoser = loser.then(() => 'success', (error: unknown) => error);
  try {
    let blocked = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const locks = await admin.pool.query(`select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid
        where not l.granted and a.datname=current_database() and a.query like 'insert into "announcements"%'`);
      if (locks.rowCount) { blocked = true; break; }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(blocked).toBe(true);
    release();
    expect(await winner).toMatchObject({ version: 1 });
    expect(await settledLoser).toMatchObject({ code: 'version_conflict', details: { currentVersion: 1, state: 'active' } });
    expect(await counts(seed)).toEqual([1, 1, 1, 0]);
  } finally { release(); await Promise.allSettled([winner, loser]); }
  // An inconsistent revision is a different unique constraint: never misreport it as a live-row conflict.
  const second = await project(seed, 'orphan-revision');
  await admin.db.insert(schema.announcementRevisions).values({ id: newId(), scope: 'project', orgId: seed.orgId, projectId: second, title: 'orphan', body: '', version: 1, authorUserId: seed.userId });
  await expect(publish(seed, second)).rejects.toMatchObject({ cause: { code: '23505', constraint: 'announcement_revisions_version' } });
  expect(await getProjectAnnouncement(owner(seed), second, runtime.db)).toBeNull();
});

test('restricted selection filters SQL bodies and forged project continuations are rechecked', async () => {
  const seed = await seedOrg(admin.db, 't26-grants');
  const hidden = await project(seed, 'hidden');
  await publish(seed, seed.projectId, 'Visible body '.repeat(100));
  await publish(seed, hidden, 'HIDDEN BODY');
  const principal = agentPrincipal(seed);
  const initial = await checkBoard(principal, { projectId: seed.projectId, budgetBytes: 8 }, runtime.db);
  expect(initial.announcements.projects.map((row) => row.projectId)).toEqual([seed.projectId]);
  expect(JSON.stringify(initial)).not.toContain('HIDDEN');
  expect(JSON.stringify(initial)).not.toContain(hidden);
  const token = initial.announcements.projects[0]!.continuation!;
  const payload = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString());
  const [hiddenRow] = await admin.db.select().from(schema.announcements).where(eq(schema.announcements.projectId, hidden));
  const forged = sign(payload, { ...payload, projectId: hidden, id: hiddenRow!.id });
  await expect(checkBoard(principal, { projectId: seed.projectId, continuation: forged }, runtime.db)).rejects.toMatchObject({ code: 'invalid_cursor', details: { resync: expect.any(String) } });
  const edited = `${Buffer.from(JSON.stringify({ ...payload, projectId: hidden })).toString('base64url')}.${token.split('.')[1]}`;
  await expect(checkBoard(principal, { projectId: seed.projectId, continuation: edited }, runtime.db)).rejects.toMatchObject({ code: 'invalid_cursor' });
  await expect(getProjectAnnouncement(principal, hidden, runtime.db)).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  const statements: string[] = [];
  const counted = drizzle(runtime.pool, { schema, logger: { logQuery(query) { statements.push(query); } } });
  await withOrgTx(owner(seed), (tx, ctx) => getProjectAnnouncementsInTx(tx, ctx, [seed.projectId]), counted);
  const query = statements.find((query) => query.includes('from "announcements"'))!;
  expect(query).toMatch(/where.*"scope".*"org_id".*"project_id" in/);
  statements.length = 0;
  await getAnnouncements(owner(seed), counted);
  expect(statements.find((query) => query.includes('from "announcements"'))).toMatch(/where.*"scope".*"org_id"/);
  // Re-sign a continuation with the CURRENT binding but an unselected id to test selection independently of MAC/binding.
  await admin.db.insert(schema.tokenProjectGrants).values({ orgId: seed.orgId, tokenId: seed.tokenId, projectId: hidden, source: 'owner' });
  const updated = await checkBoard(principal, { projectId: seed.projectId, budgetBytes: 8 }, runtime.db);
  const currentPayload = JSON.parse(Buffer.from(updated.announcements.projects[0]!.continuation!.split('.')[0]!, 'base64url').toString());
  await expect(checkBoard(principal, { projectId: seed.projectId, continuation: sign(currentPayload, { ...currentPayload, projectId: hidden, id: hiddenRow!.id }) }, runtime.db)).rejects.toMatchObject({ code: 'invalid_cursor' });
  await admin.db.update(schema.agentTokens).set({ scope: 'org' }).where(eq(schema.agentTokens.id, seed.tokenId));
  expect((await checkBoard(principal, { projectId: hidden }, runtime.db)).announcements.projects[0]?.body).toBe('HIDDEN BODY');
});

test('no-change checks refresh announcements; continuations reconstruct exact UTF-8 and clear or replace invalidates', async () => {
  const seed = await seedOrg(admin.db, 't26-chunks');
  const body = 'é🙂漢字\n'.repeat(1000);
  await publish(seed, seed.projectId, body);
  const actor = agentPrincipal(seed);
  const initial = await checkBoard(actor, { projectId: seed.projectId, budgetBytes: 257 }, runtime.db);
  let text = initial.announcements.projects[0]!.body;
  let continuation = initial.announcements.projects[0]!.continuation;
  while (continuation) {
    const board = await checkBoard(actor, { projectId: seed.projectId, continuation, budgetBytes: 257 }, runtime.db);
    const row = board.announcements.projects[0]!;
    expect(row.bodyOffset).toBe(Buffer.byteLength(text));
    expect(board.budget.usedBytes).toBe(Buffer.byteLength(row.body));
    text += row.body;
    continuation = row.continuation;
  }
  expect(text).toBe(body);
  const unchanged = await checkBoard(actor, { projectId: seed.projectId, cursor: initial.nextCursor, budgetBytes: 65536 }, runtime.db);
  expect(unchanged.events).toEqual([]);
  expect(unchanged.announcements.projects[0]!.body).toBe(body);
  const markdown = renderBoardMarkdown(unchanged);
  expect(markdown).toContain(JSON.stringify(body));
  await setProjectAnnouncement(owner(seed), { projectId: seed.projectId, title: 'Updated', body: 'new', expectedVersion: 1 }, runtime.db);
  expect((await checkBoard(actor, { projectId: seed.projectId, cursor: initial.nextCursor }, runtime.db)).announcements.projects[0]?.body).toBe('new');
  await expect(checkBoard(actor, { projectId: seed.projectId, continuation: initial.announcements.projects[0]!.continuation! }, runtime.db)).rejects.toMatchObject({ code: 'invalid_cursor' });
  await setProjectAnnouncement(owner(seed), { projectId: seed.projectId, title: 'Large', body, expectedVersion: 2 }, runtime.db);
  const latest = await checkBoard(actor, { projectId: seed.projectId, budgetBytes: 10 }, runtime.db);
  await clearProjectAnnouncement(owner(seed), { projectId: seed.projectId, expectedVersion: 3 }, runtime.db);
  await expect(checkBoard(actor, { projectId: seed.projectId, continuation: latest.announcements.projects[0]!.continuation! }, runtime.db)).rejects.toMatchObject({ code: 'invalid_cursor' });
  expect((await checkBoard(actor, { projectId: seed.projectId }, runtime.db)).announcements.projects).toEqual([]);
});

test('project announcements add exactly one query at 1, 5 and 20 selected projects and retain selection order', async () => {
  const seed = await seedOrg(admin.db, 't26-query-count');
  const ids = [seed.projectId];
  while (ids.length < 20) ids.push(await project(seed, `p${ids.length}`));
  for (const id of ids) await publish(seed, id);
  // Match main's T07 fixture: ten urgent/pinned decision roots and nonempty preview pages.
  await admin.db.insert(schema.messages).values(Array.from({ length: 10 }, (_, i) => ({ id: newId(), orgId: seed.orgId, projectId: seed.projectId,
    title: `Thread ${i}`, body: 'body', category: 'decision', status: 'active', urgent: true, pinned: true, version: 1,
    lastActivityAt: new Date(), authorKind: 'human', authorUserId: seed.userId, authorDisplayName: 'Owner' })));
  let queries = 0;
  const counted = drizzle(runtime.pool, { schema, logger: { logQuery() { queries++; } } });
  const counts: number[] = [];
  for (const n of [1, 5, 20]) {
    queries = 0;
    const result = await checkBoard(owner(seed), { projectIds: ids.slice(0, n) }, counted);
    counts.push(queries);
    expect(result.announcements.projects.map((a) => a.projectId)).toEqual(result.projects.map((p) => p.id));
  }
  expect(counts).toEqual([33, 53, 128]);
  process.stdout.write(`T26 query counts: main 32/52/127; with project announcements ${counts.join('/')}\n`);
});

test('runtime RLS isolates project announcements and revisions, and composite project FK rejects foreign projects', async () => {
  const a = await seedOrg(admin.db, 't26-rls-a');
  const b = await seedOrg(admin.db, 't26-rls-b');
  const published = await publish(b);
  const foreignProject = await project(b, 'fk-target');
  const role = await runtime.pool.query('select rolsuper, rolbypassrls from pg_roles where rolname=current_user');
  expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  for (const table of [schema.announcements, schema.announcementRevisions]) {
    await runtime.db.transaction(async (tx) => {
      await setLocal(tx, 'app.org_id', a.orgId);
      expect(await tx.select().from(table).where(eq(table.orgId, b.orgId))).toEqual([]);
      expect(await tx.update(table).set({ title: 'stolen' }).where(eq(table.orgId, b.orgId)).returning()).toEqual([]);
    });
    const row = { id: newId(), scope: 'project', orgId: b.orgId, projectId: b.projectId, title: 'No', body: '', version: 2, authorUserId: a.userId };
    await expect(runtime.db.transaction(async (tx) => {
      await setLocal(tx, 'app.org_id', a.orgId);
      await tx.insert(table).values(row);
    })).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(runtime.db.transaction(async (tx) => {
      await setLocal(tx, 'app.org_id', a.orgId);
      await tx.insert(table).values({ ...row, orgId: a.orgId, projectId: foreignProject });
    })).rejects.toMatchObject({ cause: { code: '23503' } });
    expect(await admin.db.select().from(table).where(eq(table.orgId, b.orgId))).toHaveLength(1);
  }
  expect((await getProjectAnnouncement(owner(b), b.projectId, runtime.db))?.id).toBe(published.id);
});

test('budget order is site then org then selected project announcements then groups; targeted continuations lead', async () => {
  const seed = await seedOrg(admin.db, 't26-budget');
  const siteId = newId();
  await admin.db.insert(schema.announcements).values({ id: siteId, scope: 'site', title: 'Site', body: 'SS', version: 1, authorUserId: seed.userId });
  try {
    await setOrgAnnouncement(owner(seed), { title: 'Org', body: 'OO', expectedVersion: 0 }, runtime.db);
    await publish(seed, seed.projectId, 'PP');
    await admin.db.insert(schema.messages).values({ id: newId(), orgId: seed.orgId, projectId: seed.projectId, title: 'Urgent', body: 'TTTT',
      category: 'note', status: 'active', urgent: true, pinned: false, version: 1, lastActivityAt: new Date(),
      authorKind: 'human', authorUserId: seed.userId, authorDisplayName: 'Owner' });
    const initial = await checkBoard(owner(seed), { projectId: seed.projectId, budgetBytes: 5 }, runtime.db);
    expect(initial.announcements.site?.body).toBe('SS');
    expect(initial.announcements.org?.body).toBe('OO');
    expect(initial.announcements.projects[0]?.body).toBe('P');
    expect(initial.items).toEqual([]);
    expect(initial.budget.usedBytes).toBe(5);
    const projectPage = await checkBoard(owner(seed), { projectId: seed.projectId, budgetBytes: 4, continuation: initial.announcements.projects[0]!.continuation! }, runtime.db);
    expect(projectPage.announcements.projects[0]?.body).toBe('P');
    expect(projectPage.announcements.site?.body).toBe('SS');
    expect(projectPage.announcements.org?.body).toBe('O');
    const groupPage = await checkBoard(owner(seed), { projectId: seed.projectId, budgetBytes: 4, continuation: initial.groups.urgent.continuation! }, runtime.db);
    expect(groupPage.items[0]?.excerpt).toBe('TTTT');
    expect(groupPage.announcements.projects[0]).toMatchObject({ body: '', truncated: true });
  } finally { await admin.db.delete(schema.announcements).where(eq(schema.announcements.id, siteId)); }
});
