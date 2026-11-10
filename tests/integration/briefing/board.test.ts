import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as schema from '../../../src/db/schema';
import { closeDb } from '../../../src/db/client';
import { checkBoard, checkBoardInTx, renderBoardMarkdown, type CheckBoardInput, type BoardResult } from '../../../src/domain/briefing';
import { hash, sign } from '../../../src/domain/briefing/cursor';
import { appendEvents, newId, withOrgTx, type HumanPrincipal } from '../../../src/domain/kernel';
import { setLocal } from '../../../src/domain/kernel/tx';
import { getThreadInTx } from '../../../src/domain/messages';
import { seedOrg, agentPrincipal } from '../helpers';
import { briefingDatabase } from './database';

let database: Awaited<ReturnType<typeof briefingDatabase>>;
let admin: Awaited<ReturnType<typeof briefingDatabase>>['admin'];
let runtime: Awaited<ReturnType<typeof briefingDatabase>>['runtime'];
const previous = process.env.DATABASE_URL;
beforeAll(async () => {
  database = await briefingDatabase();
  ({ admin, runtime } = database);
  process.env.DATABASE_URL = database.url;
  process.env.CURSOR_HMAC_SECRET = 'briefing-test-only-signing-key-at-least-32-characters';
});
afterAll(async () => {
  await closeDb();
  if (database) await database.close();
  if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
});
type Seed = Awaited<ReturnType<typeof seedOrg>>;
async function fixture(name: string) {
  const seed = await seedOrg(admin.db, `briefing-${name}`);
  await admin.db.insert(schema.agentProjectDefaults).values({ orgId: seed.orgId, agentId: seed.agentId, projectId: seed.projectId });
  return seed;
}
async function roots(seed: Seed, count: number, options: { urgent?: boolean; pinned?: boolean; category?: string; body?: string; projectId?: string } = {}) {
  const rows = Array.from({ length: count }, (_, i) => ({ id: newId(), orgId: seed.orgId, projectId: options.projectId ?? seed.projectId,
    title: `Thread ${i}`, body: options.body ?? `Verbatim body ${i}`, category: options.category ?? 'note', status: 'active',
    urgent: options.urgent ?? false, pinned: options.pinned ?? false, version: 1, lastActivityAt: new Date(1700000000000 + i),
    authorKind: 'human', authorUserId: seed.userId, authorDisplayName: 'Owner' }));
  await admin.db.insert(schema.messages).values(rows);
  return rows.map((row) => row.id);
}
async function check(seed: Seed, input: CheckBoardInput = {}) {
  return withOrgTx(agentPrincipal(seed), (tx, ctx) => checkBoardInTx(tx, ctx, input), runtime.db);
}
async function event(seed: Seed, kind: 'message.created' | 'access.changed' = 'message.created', projectId: string | null = seed.projectId) {
  return withOrgTx(agentPrincipal(seed), (tx, ctx) => appendEvents(tx, ctx.orgId, [{ kind, projectId }]), runtime.db);
}
async function project(seed: Seed, slug: string, grant = false) {
  const id = newId();
  await admin.db.insert(schema.projects).values({ id, orgId: seed.orgId, slug, name: slug, status: 'active', createdByKind: 'human', createdByUserId: seed.userId });
  if (grant) await admin.db.insert(schema.tokenProjectGrants).values({ orgId: seed.orgId, tokenId: seed.tokenId, projectId: id, source: 'owner' });
  return id;
}
async function announcement(seed: Seed, scope: 'site' | 'org', body: string) {
  const id = newId();
  await admin.db.insert(schema.announcements).values({ id, scope, orgId: scope === 'org' ? seed.orgId : null, title: `${scope} title`, body, version: 1, authorUserId: seed.userId });
  return id;
}
function bytes(result: BoardResult) {
  return result.items.reduce((sum, item) => sum + Buffer.byteLength(item.excerpt), 0)
    + Buffer.byteLength(result.announcements.site?.body ?? '') + Buffer.byteLength(result.announcements.org?.body ?? '');
}

test('late commits survive the initial cursor (real pg_locks counter barrier)', async () => {
  const seed = await fixture('late');
  let release!: () => void;
  let armed!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { armed = resolve; });
  const writer = runtime.db.transaction(async (tx) => {
    await setLocal(tx, 'app.org_id', seed.orgId);
    await appendEvents(tx, seed.orgId, [{ kind: 'message.created', projectId: seed.projectId }]);
    armed(); await hold;
  });
  await ready;
  const waiter = runtime.db.transaction(async (tx) => {
    await setLocal(tx, 'app.org_id', seed.orgId);
    await appendEvents(tx, seed.orgId, [{ kind: 'message.replied', projectId: seed.projectId }]);
  });
  try {
    const deadline = Date.now() + 5000;
    let blocked = false;
    while (Date.now() < deadline) {
      const locks = await admin.pool.query(`select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid
        where not l.granted and a.datname=current_database() and a.query like '%org_event_counters%'`);
      if (locks.rowCount) { blocked = true; break; }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(blocked).toBe(true);
    const initial = await check(seed);
    expect(initial.events).toEqual([]);
    release(); await Promise.all([writer, waiter]);
    const next = await check(seed, { cursor: initial.nextCursor });
    expect(next.events.map((e) => e.kind)).toEqual(['message.created', 'message.replied']);
    expect(next.hasMore).toBe(false);
  } finally { release(); await Promise.allSettled([writer, waiter]); }
});

test('independent sessions, cursor loss and unfiltered event pagination across views', async () => {
  const seed = await fixture('sessions');
  const [root] = await roots(seed, 1, { urgent: true });
  const initial = await check(seed, { view: 'urgent' });
  const sessionId = newId();
  await admin.db.insert(schema.agentSessions).values({ id: sessionId, orgId: seed.orgId, agentId: seed.agentId, tokenId: seed.tokenId });
  for (let i = 0; i < 3; i++) await event(seed);
  const a = await check(seed, { cursor: initial.nextCursor, view: 'urgent', limit: 1 });
  const b = await check({ ...seed, sessionId }, { cursor: initial.nextCursor, view: 'urgent', limit: 1 });
  expect(a.events).toEqual(b.events);
  expect(a.events).toHaveLength(1);
  expect(a.hasMore).toBe(true);
  const second = await check(seed, { cursor: a.nextCursor, view: 'urgent', limit: 1 });
  expect(second.events[0]!.seq).toBe(a.events[0]!.seq + 1);
  const third = await check(seed, { cursor: second.nextCursor, view: 'urgent', limit: 1 });
  expect(third.events).toHaveLength(1); expect(third.hasMore).toBe(false);
  expect((await check(seed)).groups.urgent.threadIds).toContain(root);
});

test('invalid cursors and continuations reject tampering, foreign org, old version, changed view and grants with resync', async () => {
  const seed = await fixture('invalid');
  await roots(seed, 3, { urgent: true });
  const initial = await check(seed, { limit: 1 });
  const foreign = await fixture('foreign');
  const fail = (promise: Promise<unknown>) => expect(promise).rejects.toMatchObject({ code: 'invalid_cursor', details: { resync: expect.any(String) } });
  await fail(check(seed, { cursor: `x${initial.nextCursor}` }));
  await fail(check(foreign, { cursor: initial.nextCursor }));
  await fail(check(seed, { cursor: initial.nextCursor, view: 'urgent' }));
  await fail(check(seed, { continuation: `x${initial.groups.urgent.continuation}` }));
  const payload = JSON.parse(Buffer.from(initial.nextCursor.split('.')[0]!, 'base64url').toString());
  const { org, scope_hash, filter_hash } = payload;
  await fail(check(seed, { cursor: sign({ org, scope_hash, filter_hash }, { type: 'events', seq: 0, v: 0 }) }));
  await project(seed, 'new-grant', true);
  await fail(check(seed, { cursor: initial.nextCursor }));
  await fail(check(seed, { continuation: initial.groups.urgent.continuation! }));
});

test('removed grants invalidate a cursor even when no default selection remains', async () => {
  const seed = await fixture('removed-grant');
  const initial = await check(seed);
  await admin.db.delete(schema.tokenProjectGrants).where(eq(schema.tokenProjectGrants.tokenId, seed.tokenId));
  const freshPrincipal = { ...agentPrincipal(seed), projectIds: [] };
  await expect(withOrgTx(freshPrincipal, (tx, ctx) => checkBoardInTx(tx, ctx, { cursor: initial.nextCursor }), runtime.db))
    .rejects.toMatchObject({ code: 'invalid_cursor', details: { resync: expect.any(String) } });
});

test('access.changed sets resync without exposing unrelated entity ids', async () => {
  const seed = await fixture('access');
  const initial = await check(seed);
  await event(seed, 'access.changed', null);
  const next = await check(seed, { cursor: initial.nextCursor });
  expect(next.resync).toEqual(expect.any(String));
  expect(next.events).toEqual([]);
  expect(next.nextCursor).not.toBe(initial.nextCursor);
});

test('large sets are byte bounded and every group and announcement continuation reaches all content', async () => {
  const seed = await fixture('budget');
  const urgent = await roots(seed, 60, { urgent: true, body: '🌊'.repeat(512) });
  const pinned = await roots(seed, 40, { pinned: true, body: 'p'.repeat(512) });
  const body = '🌊'.repeat(4096);
  await announcement(seed, 'site', body);
  await announcement(seed, 'org', body);
  try {
    const initial = await check(seed);
    expect(bytes(initial)).toBeLessThanOrEqual(12288);
    expect(initial.groups.urgent).toMatchObject({ count: 60, truncated: true });
    expect(initial.groups.pinned).toMatchObject({ count: 40, truncated: true });
    for (const [group, expected] of [['urgent', urgent], ['pinned', pinned]] as const) {
      const seen = new Set(initial.groups[group].threadIds);
      let continuation = initial.groups[group].continuation;
      for (let page = 0; continuation && page < 30; page++) {
        const result = await check(seed, { continuation });
        expect(bytes(result)).toBeLessThanOrEqual(12288);
        expect(result.budget.usedBytes).toBe(bytes(result));
        for (const id of result.groups[group].threadIds) seen.add(id);
        continuation = result.groups[group].continuation;
      }
      expect(continuation).toBeNull();
      expect([...seen].sort()).toEqual([...expected].sort());
    }
    for (const scope of ['site', 'org'] as const) {
      let text = initial.announcements[scope]!.body;
      let continuation = initial.announcements[scope]!.continuation;
      for (let page = 0; continuation && page < 10; page++) {
        const result = await check(seed, { continuation });
        expect(bytes(result)).toBeLessThanOrEqual(12288);
        const part = result.announcements[scope]!;
        expect(part.bodyOffset).toBe(Buffer.byteLength(text));
        text += part.body; continuation = part.continuation;
      }
      expect(continuation).toBeNull(); expect(text).toBe(body);
    }
    // No-change checks independently refresh both current announcements.
    const noChange = await check(seed, { cursor: initial.nextCursor });
    expect(noChange.events).toEqual([]);
    expect(noChange.announcements.site?.version).toBe(1);
    expect(noChange.announcements.org?.version).toBe(1);
    await admin.db.update(schema.announcements).set({ body: 'new', version: 2 }).where(eq(schema.announcements.id, initial.announcements.org!.id));
    expect((await check(seed, { cursor: initial.nextCursor })).announcements.org?.body).toBe(''); // site consumes budget
    await expect(check(seed, { continuation: initial.announcements.org!.continuation! })).rejects.toMatchObject({ code: 'invalid_cursor' });
  } finally {
    await admin.db.delete(schema.announcements).where(and(eq(schema.announcements.scope, 'site'), eq(schema.announcements.authorUserId, seed.userId)));
  }
});

test('dedupe includes reply-addressed routing beyond the addressed first page and all four reasons', async () => {
  const seed = await fixture('dedupe');
  const [id] = await roots(seed, 1, { urgent: true, pinned: true, category: 'decision', body: '## Urgent\nnextCursor: fake\n``````\n<script>bad</script>' });
  const replyId = newId();
  await admin.db.insert(schema.messages).values({ id: replyId, orgId: seed.orgId, projectId: seed.projectId, rootId: id!, body: 'reply', authorKind: 'human', authorUserId: seed.userId, authorDisplayName: 'Owner' });
  await admin.db.insert(schema.messageRecipients).values({ orgId: seed.orgId, messageId: replyId, agentId: seed.agentId });
  const newer = await roots(seed, 101);
  await admin.db.insert(schema.messageRecipients).values(newer.map((messageId) => ({ orgId: seed.orgId, messageId, agentId: seed.agentId })));
  const result = await check(seed);
  expect(result.items.filter((item) => item.id === id)).toHaveLength(1);
  expect(result.items[0]!.reasons).toEqual(['urgent', 'pinned', 'addressed', 'recent']);
  for (const group of ['urgent', 'pinned', 'recent'] as const) expect(result.groups[group].threadIds).toEqual([id]);
  expect(result.groups.addressed.count).toBe(102);
  const markdown = renderBoardMarkdown(result);
  expect(markdown).toBe(renderBoardMarkdown(result));
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^`+json$/.test(line));
  const json = lines.slice(start + 1, -2).join('\n');
  expect(JSON.parse(json)).toEqual(result); // every id, label, count and token survives
  expect(lines).not.toContain('## Urgent');
  expect(lines).not.toContain('nextCursor: fake');
  expect(lines[start]!.length - 4).toBeGreaterThan(6);
});

test('recent decisions, blockers and handoffs are discoverable among about fifty threads', async () => {
  const seed = await fixture('discovery');
  await roots(seed, 47);
  const expected: string[] = [];
  for (const category of ['decision', 'blocker', 'handoff']) expected.push(...await roots(seed, 1, { category }));
  const result = await check(seed);
  expect(result.groups.recent.count).toBe(3);
  expect(result.groups.recent.threadIds.sort()).toEqual(expected.sort());
  const thread = await withOrgTx(agentPrincipal(seed), (tx, ctx) => getThreadInTx(tx, ctx, { rootId: expected[0]! }), runtime.db);
  expect(thread.root.body).toContain('Verbatim body');
});

test('restricted scope excludes hidden project groups, counts, continuation content and interleaved events', async () => {
  const seed = await fixture('scope');
  const hidden = await project(seed, 'hidden-secret');
  const hiddenIds = await roots(seed, 4, { urgent: true, pinned: true, projectId: hidden, body: 'hidden-body' });
  const visibleIds = await roots(seed, 3, { urgent: true });
  const initial = await check(seed, { limit: 1 });
  await event(seed); await event(seed, 'message.created', hidden); await event(seed);
  let next = await check(seed, { cursor: initial.nextCursor, limit: 1 });
  expect(next.events).toHaveLength(1);
  next = await check(seed, { cursor: next.nextCursor, limit: 1 });
  expect(next.events).toEqual([]); expect(next.hasMore).toBe(true);
  next = await check(seed, { cursor: next.nextCursor, limit: 1 });
  expect(next.events).toHaveLength(1); expect(next.hasMore).toBe(false);
  expect(initial.groups.urgent.count).toBe(3);
  expect(initial.groups.pinned.none).toBe(true);
  const continued = await check(seed, { continuation: initial.groups.urgent.continuation!, limit: 100 });
  const serialized = JSON.stringify([initial, next, continued]);
  for (const value of [hidden, ...hiddenIds, 'hidden-body', 'hidden-secret']) expect(serialized).not.toContain(value);
  expect(continued.groups.urgent.threadIds.every((id) => visibleIds.includes(id))).toBe(true);
  await expect(check(seed, { projectId: hidden })).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
});

test('humans require explicit projects, addressed is agent-only, unresolved agents and malformed input fail', async () => {
  const seed = await fixture('human');
  const human: HumanPrincipal = { kind: 'human', orgId: seed.orgId, userId: seed.userId, siteAdmin: false, interface: 'web', requestId: randomUUID() };
  await expect(checkBoard(human, {}, runtime.db)).rejects.toMatchObject({ code: 'no_project_selected' });
  await expect(checkBoard(human, { projectId: seed.projectId, view: 'addressed' }, runtime.db)).rejects.toMatchObject({ code: 'validation_failed' });
  const result = await checkBoard(human, { projectIds: [seed.projectId] }, runtime.db);
  expect(result.identity).toEqual({ kind: 'human', userId: seed.userId });
  expect(result.groups.addressed.none).toBe(true);
  await expect(checkBoard({ ...agentPrincipal(seed), sessionId: null }, {}, runtime.db)).rejects.toMatchObject({ code: 'unauthenticated' });
  for (const input of [{ limit: 101 }, { budgetBytes: 65537 }, { projectId: 'bad' }, { unexpected: true }]) {
    await expect(check(seed, input as CheckBoardInput)).rejects.toMatchObject({ code: 'validation_failed' });
  }
});

test('query count is independent of items/events; measure one, five and twenty selected projects', async () => {
  const seed = await fixture('queries');
  let queries = 0;
  const counted = drizzle(runtime.pool, { schema, logger: { logQuery() { queries++; } } });
  const measure = async (projectIds: string[]) => {
    queries = 0;
    const principal: HumanPrincipal = { kind: 'human', orgId: seed.orgId, userId: seed.userId, siteAdmin: false, interface: 'web', requestId: 'query-count' };
    await checkBoard(principal, { projectIds }, counted);
    return queries;
  };
  await roots(seed, 10, { urgent: true, pinned: true, category: 'decision' });
  const ten = await measure([seed.projectId]);
  await roots(seed, 190, { urgent: true, pinned: true, category: 'decision' });
  const twoHundred = await measure([seed.projectId]);
  expect(twoHundred).toBe(ten);
  const ids = [seed.projectId];
  while (ids.length < 20) ids.push(await project(seed, `project-${ids.length}`));
  const five = await measure(ids.slice(0, 5));
  const twenty = await measure(ids);
  process.stdout.write(`T07 SQL statements: 1 project/10 threads=${ten}, 1 project/200 threads=${twoHundred}, 5 projects=${five}, 20 projects=${twenty}\n`);
  expect(five).toBeGreaterThan(ten); expect(twenty).toBeGreaterThan(five);
  // No output count can drive per-item queries: page size 1 and 100 use the same statements.
  const principal: HumanPrincipal = { kind: 'human', orgId: seed.orgId, userId: seed.userId, siteAdmin: false, interface: 'web', requestId: 'query-count' };
  queries = 0; await checkBoard(principal, { projectId: seed.projectId, limit: 1 }, counted); const one = queries;
  queries = 0; await checkBoard(principal, { projectId: seed.projectId, limit: 100 }, counted); expect(queries).toBe(one);
  expect(hash({ a: 1 })).toHaveLength(64);
});


test('group continuation traverses beyond the underlying 100-item source page', async () => {
  const seed = await fixture('deep-page');
  const ids = await roots(seed, 205, { urgent: true });
  let result = await check(seed, { limit: 17 });
  const seen: string[] = [];
  for (let page = 0; page < 20; page++) {
    seen.push(...result.groups.urgent.threadIds);
    const continuation = result.groups.urgent.continuation;
    if (!continuation) break;
    result = await check(seed, { continuation, limit: 17 });
  }
  expect(result.groups.urgent.truncated).toBe(false);
  expect(seen.length).toBe(205);
  expect([...new Set(seen)].sort()).toEqual(ids.sort());
});

test('events committed after W are discarded from this page and delivered on the next check', async () => {
  const seed = await fixture('upper-bound');
  const initial = await check(seed);
  await event(seed);
  const result = await withOrgTx(agentPrincipal(seed), async (tx, ctx) => {
    // Instrument the actual PostgreSQL connection, not domain data or results.
    // Commit a second writer immediately after the counter SELECT has completed.
    const session = (tx as unknown as { session: { client: import('pg').PoolClient } }).session;
    const original = session.client;
    let injected = false;
    const statements: string[] = [];
    session.client = new Proxy(original, {
      get(target, key) {
        if (key !== 'query') return Reflect.get(target, key);
        return async (...args: unknown[]) => {
          const query = typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text;
          statements.push(query);
          const value: unknown = await Reflect.apply(target.query, target, args);
          if (!injected && query.includes('"last_seq"') && query.includes('"org_event_counters"')) {
            injected = true;
            await event(seed);
          }
          return value;
        };
      },
    });
    try {
      const board = await checkBoardInTx(tx, ctx, { cursor: initial.nextCursor });
      expect(injected).toBe(true);
      const watermarkIndex = statements.findIndex((query) => query.includes('"last_seq"'));
      const firstSnapshotIndex = statements.findIndex((query) => query.includes('"messages"'));
      expect(watermarkIndex).toBeLessThan(firstSnapshotIndex);
      return board;
    } finally { session.client = original; }
  }, runtime.db);
  expect(result.events.map((e) => e.seq)).toEqual([1]);
  expect(result.hasMore).toBe(false); // false at W=1; the newer commit is for the next check
  const next = await check(seed, { cursor: result.nextCursor });
  expect(next.events.map((e) => e.seq)).toEqual([2]);
});


test('continuation-only pagination retains the originating feed position instead of skipping new events', async () => {
  const seed = await fixture('continuation-events');
  await roots(seed, 3, { urgent: true });
  await announcement(seed, 'org', 'a'.repeat(16384));
  const initial = await check(seed, { limit: 1 });
  await event(seed);
  for (const continuation of [initial.groups.urgent.continuation!, initial.announcements.org!.continuation!]) {
    const continued = await check(seed, { continuation, limit: 1 });
    expect(continued.events.map((e) => e.seq)).toEqual([1]);
    const next = await check(seed, { cursor: continued.nextCursor });
    expect(next.events).toEqual([]);
  }
});
