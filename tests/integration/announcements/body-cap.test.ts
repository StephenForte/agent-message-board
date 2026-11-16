import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as schema from '../../../src/db/schema';
import { closeDb } from '../../../src/db/client';
import { setOrgAnnouncement, setSiteAnnouncement, setProjectAnnouncement } from '../../../src/domain/announcements';
import { createToken } from '../../../src/domain/credentials';
import { checkBoard } from '../../../src/domain/briefing';
import { newId, type HumanPrincipal } from '../../../src/domain/kernel';
import { PUT } from '../../../src/app/api/v1/projects/[projectSlug]/announcement/route';
import { agentPrincipal, seedOrg } from '../helpers';
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
  return { kind: 'human', userId: seed.userId, orgId: seed.orgId, role: 'owner', siteAdmin: true, requestId: newId(), interface: 'web' };
}
async function snapshot() {
  return {
    current: await fixture.admin.db.select().from(schema.announcements).orderBy(schema.announcements.id),
    revisions: await fixture.admin.db.select().from(schema.announcementRevisions).orderBy(schema.announcementRevisions.id),
    audits: await fixture.admin.db.select().from(schema.auditRecords).orderBy(schema.auditRecords.id),
  };
}
const encodings = ['ASCII', 'UTF-8'] as const;
function exactBody(encoding: typeof encodings[number]) {
  return encoding === 'ASCII' ? 'x'.repeat(262144) : 'é🙂'.repeat(43690) + '🙂';
}

test.each(['site', 'org', 'project'] as const)('%s accepts exact ASCII and UTF-8 caps and rejects one extra byte without writes', async scope => {
  const seed = await seedOrg(fixture.admin.db, `t28-${scope}`);
  await fixture.admin.db.insert(schema.siteAdmins).values({ userId: seed.userId });
  let version = 0;
  const write = async (title: string, body: string) => {
    const input = { title, body, expectedVersion: version };
    return scope === 'site' ? setSiteAnnouncement(owner(seed), input, fixture.runtime.db)
      : scope === 'org' ? setOrgAnnouncement(owner(seed), input, fixture.runtime.db)
      : setProjectAnnouncement(owner(seed), { ...input, projectId: seed.projectId }, fixture.runtime.db);
  };
  for (const encoding of encodings) {
    const body = exactBody(encoding);
    expect(Buffer.byteLength(body)).toBe(262144);
    const saved = await write('é'.repeat(8192), body);
    version = saved.version;
    const before = await snapshot();
    expect(before.current.find(row => row.id === saved.id)?.body).toBe(body);
    expect(before.revisions.find(row => row.announcementId === saved.id && row.version === version)?.body).toBe(body);
    for (const [title, invalidBody] of [['Valid', body + 'a'], ['a'.repeat(16385), 'Valid'], ['é'.repeat(8192) + 'a', 'Valid']]) {
      await expect(write(title!, invalidBody!)).rejects.toMatchObject({ code: 'content_too_large' });
      expect(await snapshot()).toEqual(before);
    }
  }
});

async function writer(label: string) {
  const seed = await seedOrg(fixture.admin.db, label);
  const token = await createToken(owner(seed), { label: 'Scratch writer', scope: 'org', canSetProjectAnnouncements: true });
  return { seed, secret: token.secret };
}
async function rawPut(secret: string | undefined, body: BodyInit, extraHeaders: Record<string, string> = {}) {
  return PUT(new Request('http://localhost/api/v1/projects/alpha/announcement', {
    method: 'PUT', headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...extraHeaders }, body,
    duplex: 'half',
  } as RequestInit), { params: Promise.resolve({ projectSlug: 'alpha' }) });
}

test('token PUT accepts both exact byte caps and refuses oversized bodies and titles without revisions', async () => {
  const { seed, secret } = await writer('t28-token-boundaries');
  for (const encoding of encodings) {
    const body = exactBody(encoding);
    const response = await rawPut(secret, JSON.stringify({ title: 'a'.repeat(16384), body }));
    expect(response.status).toBe(200);
    const before = await snapshot();
    expect(before.current.find(row => row.projectId === seed.projectId)?.body).toBe(body);
    for (const input of [{ title: 'Valid', body: body + 'a' }, { title: 'a'.repeat(16385), body: 'Valid' }]) {
      const denied = await rawPut(secret, JSON.stringify(input));
      expect(denied.status).toBe(400);
      expect(await denied.json()).toEqual({ error: { code: 'content_too_large' } });
      expect(await snapshot()).toEqual(before);
    }
  }
});

test('declared oversized invalid JSON is refused without reading or writing', async () => {
  const { secret } = await writer('t28-declared');
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(1)); } }, { highWaterMark: 0 });
  const before = await snapshot();
  const response = await rawPut(secret, stream, { 'content-length': '300000' });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: 'content_too_large' } });
  expect(pulled).toBe(0);
  await stream.cancel();
  expect(await snapshot()).toEqual(before);
});

test.each([undefined, '1'])('stream cap cancels early with Content-Length %s and never parses oversized invalid JSON', async declared => {
  const { secret } = await writer('t28-stream');
  let pulls = 0, cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode('!'.repeat(60000))); if (pulls === 10) controller.close(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const before = await snapshot();
  const response = await rawPut(secret, stream, declared ? { 'content-length': declared } : {});
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: 'content_too_large' } });
  expect(pulls).toBe(5); // 300000 observed bytes; the rest is never read.
  expect(cancelled).toBe(true);
  expect(await snapshot()).toEqual(before);
});

test('request bound is inclusive and authentication and rate limiting still precede body validation', async () => {
  const { seed, secret } = await writer('t28-order');
  for (const [size, code] of [[279552, 'validation_failed'], [279553, 'content_too_large']] as const) {
    const response = await rawPut(secret, '!'.repeat(size));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code } });
  }
  expect((await rawPut(undefined, '!'.repeat(300000))).status).toBe(401);
  await fixture.admin.pool.query(`update rate_limit_windows set count=30 where token_id=(select id from agent_tokens where org_id=$1 and label='Scratch writer')`, [seed.orgId]);
  expect((await rawPut(secret, '!'.repeat(300000))).status).toBe(429);
  expect(await fixture.admin.db.select().from(schema.announcementRevisions).where(eq(schema.announcementRevisions.orgId, seed.orgId))).toHaveLength(0);
});

test('118415-byte project announcement reconstructs exactly through default-budget check_board continuations', async () => {
  const seed = await seedOrg(fixture.admin.db, 't28-chunks');
  const body = 'é🙂漢字\n'.repeat(9108) + 'abcdefghijk';
  expect(Buffer.byteLength(body)).toBe(118415);
  await setProjectAnnouncement(owner(seed), { projectId: seed.projectId, title: 'Snapshot', body, expectedVersion: 0 }, fixture.runtime.db);
  const actor = agentPrincipal(seed);
  let text = '', continuation: string | undefined;
  let pages = 0;
  do {
    const board = await checkBoard(actor, { projectId: seed.projectId, ...(continuation ? { continuation } : {}) }, fixture.runtime.db);
    const row = board.announcements.projects[0]!;
    expect(row.bodyOffset).toBe(Buffer.byteLength(text));
    expect(row.bodyBytes).toBe(118415);
    expect(board.budget.budgetBytes).toBe(12288);
    expect(board.budget.usedBytes).toBeLessThanOrEqual(12288);
    text += row.body;
    continuation = row.continuation ?? undefined;
    expect(++pages).toBeLessThan(20);
  } while (continuation);
  expect(pages).toBeGreaterThan(1);
  expect(text).toBe(body);
});


test('a failed request stream retains the previous 400 validation_failed response without writes', async () => {
  const { secret } = await writer('t28-read-failure');
  const before = await snapshot();
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('private stream failure')); } }, { highWaterMark: 0 });
  const response = await rawPut(secret, stream);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { code: 'validation_failed' } });
  expect(await snapshot()).toEqual(before);
});
