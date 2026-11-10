import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { closeDb } from '../../../src/db/client';
import * as kernel from '../../../src/domain/kernel';
import { getThread, getThreadHistory, getThreadHistoryInTx, getThreadInTx, listThreads, listThreadsInTx, postReply, postRoot, updateRootFlags } from '../../../src/domain/messages';
import { runtimeUrl } from '../helpers';
import { admin, hiddenProject, runtime, schema, seed } from './fixtures';

beforeAll(() => { process.env.DATABASE_URL = runtimeUrl(); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await closeDb(); await admin.pool.end(); await runtime.pool.end(); });
const rootData = (projectId: string, extra = {}) => ({ projectId, title: 'Root', body: '**raw** <script>raw</script>', idempotencyKey: kernel.newId(), ...extra });

test('human and agent provenance, recipients deduplicate, raw bodies and InTx composition', async () => {
  const s = await seed();
  const root = await postRoot(s.human, rootData(s.projectId, { recipients: [s.agentId, s.agentId.toUpperCase()] }));
  expect(root.authorDisplayName).toBe('Real Owner');
  expect(root.authorKind).toBe('human');
  const reply = await postReply(s.agent, { rootId: root.id, body: 'Agent reply', recipients: [s.agentId], idempotencyKey: kernel.newId() });
  expect(reply).toMatchObject({ projectId: s.projectId, authorDisplayName: 'agent', authorTokenId: s.tokenId, authorSessionId: s.sessionId });
  const composed = await kernel.withOrgTx(s.agent, async (tx, ctx) => ({
    list: await listThreadsInTx(tx, ctx, { projectIds: [s.projectId.toUpperCase()] }),
    thread: await getThreadInTx(tx, ctx, { rootId: root.id }),
    history: await getThreadHistoryInTx(tx, ctx, root.id),
  }), runtime.db);
  expect(composed.list.items[0]).toMatchObject({ projectSlug: 'board', projectName: 'Board', replyCount: 1, recipients: [{ id: s.agentId, name: 'agent' }] });
  expect(composed.thread.root.body).toBe('**raw** <script>raw</script>');
  expect(composed.thread.replies[0]?.recipients).toEqual([{ id: s.agentId, name: 'agent' }]);
  expect(composed.thread.root.lastActivityAt! >= root.lastActivityAt!).toBe(true);
  expect(composed.history).toEqual([]);
});

test('idempotency replays JSON exactly, conflicts and collapses concurrent posts', async () => {
  const s = await seed();
  const data = rootData(s.projectId);
  const results = await Promise.all([postRoot(s.agent, data), postRoot(s.agent, data)]);
  expect(results[0]).toEqual(results[1]);
  expect(await postRoot(s.agent, data)).toEqual(results[0]);
  await expect(postRoot(s.agent, { ...data, body: 'different' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
  expect((await getThread(s.agent, { rootId: results[0]!.id })).root.id).toBe(results[0]!.id);
  const replyData = { rootId: results[0]!.id, body: 'reply', idempotencyKey: kernel.newId() };
  expect(await postReply(s.agent, replyData)).toEqual(await postReply(s.agent, replyData));
  const flags = { rootId: results[0]!.id, expectedVersion: 1, urgent: true, idempotencyKey: kernel.newId() };
  expect(await updateRootFlags(s.agent, flags)).toEqual(await updateRootFlags(s.agent, flags));
  const rows = await admin.db.select().from(schema.messages).where(eq(schema.messages.orgId, s.orgId));
  expect(rows).toHaveLength(2);
});

test('concurrent flags return the winner version/state and no-op does not increment', async () => {
  const s = await seed();
  const root = await postRoot(s.human, rootData(s.projectId));
  const results = await Promise.allSettled([true, false].map((pinned) => updateRootFlags(s.agent, {
    rootId: root.id, expectedVersion: 1, urgent: true, pinned, idempotencyKey: kernel.newId(),
  })));
  const winner = results.find((r) => r.status === 'fulfilled');
  const loser = results.find((r) => r.status === 'rejected');
  expect(winner?.status).toBe('fulfilled');
  expect(loser?.status).toBe('rejected');
  if (winner?.status !== 'fulfilled' || loser?.status !== 'rejected') throw new Error('missing concurrent result');
  expect(loser.reason).toMatchObject({ code: 'version_conflict', details: { currentVersion: 2, state: { urgent: true, pinned: winner.value.pinned } } });
  expect(await updateRootFlags(s.human, { rootId: root.id, expectedVersion: 2, urgent: true, idempotencyKey: kernel.newId() })).toMatchObject({ version: 2 });
  expect(await getThreadHistory(s.human, root.id)).toHaveLength(1);
});

// Hold the real operation after its audit; the root lock must remain held to commit.
for (const first of ['archive', 'reply'] as const) test(`root-lock barrier: ${first} commits first`, async () => {
  const s = await seed();
  const root = await postRoot(s.human, rootData(s.projectId));
  let release = () => {};
  let entered = () => {};
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const armed = new Promise<void>((resolve) => { entered = resolve; });
  const original = kernel.writeAudit;
  const action = first === 'archive' ? 'message.updated' : 'message.replied';
  vi.spyOn(kernel, 'writeAudit').mockImplementation(async (tx, ctx, record) => {
    await original(tx, ctx, record);
    if (record.action === action) { entered(); await hold; }
  });
  const archive = () => updateRootFlags(s.agent, { rootId: root.id, expectedVersion: 1, status: 'archived', idempotencyKey: kernel.newId() });
  const reply = () => postReply(s.agent, { rootId: root.id, body: 'racing', idempotencyKey: kernel.newId() });
  const a = (first === 'archive' ? archive() : reply());
  await armed;
  const b = (first === 'archive' ? reply() : archive());
  // Attach a rejection handler immediately, including on a negative-control failure.
  const bResult = b.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    const waiting = async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const result = await admin.pool.query<{ n: number }>(`select count(*)::int n from pg_locks l
          join pg_stat_activity a on a.pid = l.pid where a.datname = current_database()
          and not l.granted and a.query ilike '%messages%for update%' and cardinality(pg_blocking_pids(a.pid)) > 0`);
        if (result.rows[0]!.n > 0) return 'blocked';
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('No root-row lock wait observed');
    };
    expect(await Promise.race([waiting(), bResult.then(() => 'finished')])).toBe('blocked');
  } finally { release(); }
  await a;
  const result = await bResult;
  if (first === 'archive') expect(result).toMatchObject({ error: { code: 'thread_archived' } });
  else expect(result).toHaveProperty('value');
  const thread = await getThread(s.human, { rootId: root.id });
  expect(thread.root.status).toBe('archived');
  expect(thread.replies).toHaveLength(first === 'reply' ? 1 : 0);
});

test('failure after real audit rolls back message, recipients, event, audit and idempotency', async () => {
  const s = await seed();
  const original = kernel.writeAudit;
  vi.spyOn(kernel, 'writeAudit').mockImplementation(async (...args) => { await original(...args); throw new Error('injected after audit'); });
  const data = rootData(s.projectId, { recipients: [s.agentId] });
  await expect(postRoot(s.agent, data)).rejects.toThrow('injected after audit');
  for (const table of [schema.messages, schema.events, schema.auditRecords, schema.messageRecipients, schema.idempotencyRecords]) {
    const rows = await admin.db.select().from(table).where(eq(table.orgId, s.orgId));
    expect(rows).toEqual([]);
  }
  vi.restoreAllMocks();
  await expect(postRoot(s.agent, data)).resolves.toHaveProperty('id');
});

test('all validation error codes leave no posts', async () => {
  const s = await seed();
  for (const extra of [{ title: '' }, { title: 'x'.repeat(201) }, { recipients: [kernel.newId()] }, { category: 'wrong' }, { urgent: 'yes' }, { authorUserId: s.userId }]) {
    await expect(postRoot(s.agent, rootData(s.projectId, extra))).rejects.toMatchObject({ code: 'validation_failed' });
  }
  await expect(postRoot(s.agent, rootData(s.projectId, { body: '😀'.repeat(8193) }))).rejects.toMatchObject({ code: 'content_too_large' });
  await expect(postRoot({ ...s.agent, sessionId: null }, rootData(s.projectId))).rejects.toMatchObject({ code: 'unauthenticated' });
  await expect(postRoot({ ...s.agent, agentId: null }, rootData(s.projectId))).rejects.toMatchObject({ code: 'unauthenticated' });
  expect(await admin.db.select().from(schema.messages).where(eq(schema.messages.orgId, s.orgId))).toEqual([]);
  const root = await postRoot(s.human, rootData(s.projectId, { body: '😀'.repeat(8192), title: '😀'.repeat(200) }));
  const reply = await postReply(s.agent, { rootId: root.id, body: '', idempotencyKey: kernel.newId() });
  await expect(postReply(s.agent, { rootId: reply.id, body: 'nested', idempotencyKey: kernel.newId() })).rejects.toMatchObject({ code: 'validation_failed' });
  await updateRootFlags(s.agent, { rootId: root.id, expectedVersion: 1, status: 'archived', idempotencyKey: kernel.newId() });
  await expect(postReply(s.agent, { rootId: root.id, body: 'archived', idempotencyKey: kernel.newId() })).rejects.toMatchObject({ code: 'thread_archived' });
  await admin.db.update(schema.projects).set({ status: 'archived' }).where(eq(schema.projects.id, s.projectId));
  await expect(postRoot(s.human, rootData(s.projectId))).rejects.toMatchObject({ code: 'project_archived' });
  await expect(postReply(s.agent, { rootId: root.id, body: 'archived', idempotencyKey: kernel.newId() })).rejects.toMatchObject({ code: 'project_archived' });
  expect((await getThread(s.agent, { rootId: root.id })).root.status).toBe('archived');
});

test('authorization precedes search/counts, filters and pagination; reply project is derived', async () => {
  const s = await seed(), other = await seed();
  const hidden = await hiddenProject(s);
  const secret = await postRoot(s.human, rootData(hidden, { body: 'quasarword', recipients: [s.agentId] }));
  const foreign = await postRoot(other.human, rootData(other.projectId, { body: 'quasarword' }));
  // The kernel refreshes token scope; stale org-wide metadata must not bypass its current grants.
  const staleScope = { ...s.agent, scope: 'org' as const };
  await expect(getThread(staleScope, { rootId: secret.id })).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  await expect(postRoot(staleScope, rootData(hidden))).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  for (const root of [secret, foreign]) {
    await expect(getThread(s.agent, { rootId: root.id })).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
    await expect(getThreadHistory(s.agent, root.id)).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
    await expect(postReply(s.agent, { rootId: root.id, body: 'attack', idempotencyKey: kernel.newId() })).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
    await expect(updateRootFlags(s.agent, { rootId: root.id, expectedVersion: 1, urgent: true, idempotencyKey: kernel.newId() })).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
    await expect(listThreads(s.agent, { projectIds: [root.projectId] })).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
  }
  for (const filter of [{ query: 'quasarword' }, { recipientAgentId: s.agentId }, { authorUserId: s.userId }, { authorAgentId: other.agentId }]) {
    expect(await listThreads(s.agent, { projectIds: [s.projectId], ...filter })).toMatchObject({ items: [], totalCount: 0 });
  }
  await expect(postReply(s.agent, { rootId: secret.id, body: 'attack', projectId: s.projectId, idempotencyKey: kernel.newId() } as never)).rejects.toMatchObject({ code: 'validation_failed' });
});

test('reply full-text matches, root filters, archive/restore history and body-free events', async () => {
  const s = await seed();
  const root = await postRoot(s.human, rootData(s.projectId, { category: 'decision', pinned: true }));
  const reply = await postReply(s.agent, { rootId: root.id, body: 'distinctivequasar', recipients: [s.agentId], idempotencyKey: kernel.newId() });
  const results = await listThreads(s.agent, { projectIds: [s.projectId], query: 'distinctivequasar', recipientAgentId: s.agentId, category: 'decision', pinned: true, authorUserId: s.userId });
  expect(results.totalCount).toBe(1);
  expect(results.items[0]?.matches).toEqual([{ id: reply.id, rootId: root.id, excerpt: 'distinctivequasar', bodyTruncated: false }]);
  expect((await listThreads(s.agent, { projectIds: [s.projectId], urgent: true })).totalCount).toBe(0);
  await updateRootFlags(s.agent, { rootId: root.id, expectedVersion: 1, urgent: true, status: 'archived', idempotencyKey: kernel.newId() });
  expect((await listThreads(s.agent, { projectIds: [s.projectId] })).totalCount).toBe(0);
  expect((await listThreads(s.agent, { projectIds: [s.projectId], status: 'archived' })).totalCount).toBe(1);
  await updateRootFlags(s.human, { rootId: root.id, expectedVersion: 2, status: 'active', idempotencyKey: kernel.newId() });
  const history = await getThreadHistory(s.agent, root.id);
  expect(history).toHaveLength(2);
  expect(await getThreadHistory(s.agent, root.id.toUpperCase())).toEqual(history);
  expect(history[0]).toMatchObject({ actorKind: 'agent', before: { status: 'active', version: 1 }, after: { status: 'archived', version: 2 } });
  expect(history[1]).toMatchObject({ actorKind: 'human', userId: s.userId });
  const events = await admin.db.select().from(schema.events).where(eq(schema.events.orgId, s.orgId)).orderBy(schema.events.seq);
  expect(events.map((e) => e.kind)).toEqual(['message.created', 'message.replied', 'message.flag_changed', 'message.archived', 'message.restored']);
  for (const e of events) { expect(JSON.stringify(e.payload)).not.toContain('body'); expect(JSON.stringify(e.payload)).not.toContain('distinctivequasar'); }
});

test('keyset pagination keeps microsecond precision; cursors reject tampering and changed scope', async () => {
  const s = await seed();
  const roots = await Promise.all([1, 2, 3].map(() => postRoot(s.human, rootData(s.projectId, { body: 'x'.repeat(600) }))));
  // Explicit sub-millisecond timestamps exercise precision lost by JS Date.
  for (let i = 0; i < roots.length; i++) await admin.pool.query('update messages set created_at = $1, last_activity_at = $1 where id = $2', [`2026-01-01T00:00:00.00000${i + 1}Z`, roots[i]!.id]);
  for (const sort of ['activity', 'newest', 'oldest'] as const) {
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listThreads(s.agent, { projectIds: [s.projectId], limit: 1, cursor, sort });
      expect(page.totalCount).toBe(3);
      expect(page.items[0]?.excerpt.length).toBe(512);
      expect(page.items[0]?.bodyTruncated).toBe(true);
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(seen).size).toBe(3);
    expect(seen).toEqual((sort === 'oldest' ? roots : [...roots].reverse()).map((r) => r.id));
  }
  const page = await listThreads(s.agent, { projectIds: [s.projectId], limit: 1 });
  for (const cursor of ['junk', page.nextCursor + 'x']) await expect(listThreads(s.agent, { projectIds: [s.projectId], cursor })).rejects.toMatchObject({ code: 'invalid_cursor' });
  await expect(listThreads(s.agent, { projectIds: [s.projectId], urgent: true, cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'invalid_cursor' });
  const hidden = await hiddenProject(s);
  await admin.db.insert(schema.tokenProjectGrants).values({ orgId: s.orgId, tokenId: s.tokenId, projectId: hidden, source: 'owner' });
  await expect(listThreads(s.agent, { projectIds: [s.projectId], cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'invalid_cursor' });
  const rootId = roots[0]!.id;
  const replies = await Promise.all([1, 2, 3].map(() => postReply(s.agent, { rootId, body: 'page', idempotencyKey: kernel.newId() })));
  for (let i = 0; i < replies.length; i++) await admin.pool.query('update messages set created_at = $1 where id = $2', [`2026-01-01T00:00:00.00000${i + 1}Z`, replies[i]!.id]);
  const first = await getThread(s.agent, { rootId, replyLimit: 1 });
  const second = await getThread(s.agent, { rootId, replyLimit: 1, replyCursor: first.nextReplyCursor! });
  const third = await getThread(s.agent, { rootId, replyLimit: 1, replyCursor: second.nextReplyCursor! });
  expect([first, second, third].flatMap((p) => p.replies.map((r) => r.id))).toEqual(replies.map((r) => r.id));
  expect(third.nextReplyCursor).toBeNull();
  await expect(getThread(s.agent, { rootId: roots[1]!.id, replyCursor: first.nextReplyCursor! })).rejects.toMatchObject({ code: 'invalid_cursor' });
});
