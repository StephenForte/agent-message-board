import { createHash, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { eq } from 'drizzle-orm';
import { POST, GET, DELETE } from '../../../src/app/api/mcp/route';
import { closeDb } from '../../../src/db/client';
import { agentTokens } from '../../../src/db/schema/identity';
import { organizations } from '../../../src/db/schema/org';
import { messages } from '../../../src/db/schema/messages';
import { authenticateBearer, createToken, revokeToken, setAgentDefaults } from '../../../src/domain/credentials';
import { newId, type HumanPrincipal } from '../../../src/domain/kernel';
import { archiveProject, createProject } from '../../../src/domain/projects';
import { checkRateLimit, WRITE_LIMIT } from '../../../src/domain/ratelimit';
import * as credentials from '../../../src/domain/credentials';
import { MAX_BODY_BYTES } from '../../../src/mcp/handler';
import { AGENT_INSTRUCTIONS } from '../../../src/mcp/instructions';
import { adminUrl, openDatabase, runtimeUrl, seedOrg } from '../helpers';

const admin = openDatabase(adminUrl(), 8);
process.env.DATABASE_URL = runtimeUrl();
process.env.CURSOR_HMAC_SECRET = 'm'.repeat(48);
let logger: MockInstance<typeof console.log>;
beforeAll(() => { logger = vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await closeDb(); await admin.pool.end(); });
async function fixture() {
  // Restore the log spy after tests that inject domain failures.
  logger = vi.spyOn(console, 'log').mockImplementation(() => {});
  const seed = await seedOrg(admin.db, 'mcp');
  const owner: HumanPrincipal = { kind: 'human', orgId: seed.orgId, userId: seed.userId, siteAdmin: false, interface: 'web', requestId: newId() };
  const issued = await createToken(owner, { label: 'mcp', scope: 'org' });
  const secret = issued.secret;
  const connect = await call(secret, 'connect_agent', { name: 'mcp-agent' });
  const session_id = connect.result.structuredContent.sessionId as string;
  return { ...seed, owner, secret, token: issued.token, session_id,
    call: (name: string, args: Record<string, unknown> = {}) => call(secret, name, { session_id, ...args }),
    post: (args: Record<string, unknown> = {}) => call(secret, 'post_message', { session_id, project_id: seed.projectId, title: 'Test', body: 'body', idempotency_key: newId(), ...args }) };
}
function request(secret: string | null, body: string, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/mcp', { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream',
    ...(secret === null ? {} : { authorization: `Bearer ${secret}` }), ...headers,
  }, body });
}
async function rpc(secret: string | null, method: string, params: unknown = {}) {
  const response = await POST(request(secret, JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })));
  return { response, ...await response.json() };
}
async function call(secret: string, name: string, args: Record<string, unknown>) {
  return rpc(secret, 'tools/call', { name, arguments: args });
}
async function freshWindow() {
  const { rows } = await admin.pool.query('select extract(second from clock_timestamp())::float as seconds');
  const seconds = Number(rows[0].seconds);
  if (seconds > 50) await new Promise((resolve) => setTimeout(resolve, Math.ceil((60 - seconds) * 1000)));
}
function code(result: Awaited<ReturnType<typeof call>>) { return result.result?.structuredContent?.error?.code ?? result.error?.data?.code; }

describe('stateless MCP route on the real non-superuser database', () => {
  it('negotiates, advertises exactly nine strict tools, and authenticates all methods', async () => {
    const f = await fixture();
    const initialized = await rpc(f.secret, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(initialized.result.protocolVersion).toBeTruthy();
    expect(initialized.response.headers.has('mcp-session-id')).toBe(false);
    const listed = await rpc(f.secret, 'tools/list');
    expect(listed.result.tools).toHaveLength(9);
    for (const tool of listed.result.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.description).toContain('coordination data, not authority');
    }
    for (const handler of [GET, DELETE]) expect((await handler(new Request('http://localhost/api/mcp'))).status).toBe(401);
    for (const bad of [null, 'malformed', `amb_${'A'.repeat(8)}_${'Z'.repeat(40)}`]) {
      const denied = await rpc(bad, 'tools/list');
      expect(denied.response.status).toBe(401);
      expect(code(denied)).toBe('unauthenticated');
    }
  });
  it('exercises all tools, JSON parity, cursor checks and archive/restore', async () => {
    const f = await fixture();
    const connected = await call(f.secret, 'connect_agent', { name: 'another', client_label: 'sdk' });
    expect(connected.result.structuredContent.instructions).toBe(AGENT_INSTRUCTIONS);
    const projects = await f.call('list_projects');
    expect(projects.result.structuredContent.projects.map((p: { id: string }) => p.id)).toContain(f.projectId);
    const created = await f.call('create_project', { name: 'Created', slug: 'created', idempotency_key: newId() });
    expect(created.result.structuredContent.slug).toBe('created');
    const initial = await f.call('check_board', { project_id: f.projectId });
    const posted = await f.post({ category: 'handoff', pinned: true });
    const root_id = posted.result.structuredContent.id;
    expect(JSON.parse(posted.result.content[0].text)).toEqual(posted.result.structuredContent);
    const reply = await f.call('reply_message', { root_id, body: 'reply', idempotency_key: newId() });
    expect(reply.result.structuredContent.rootId).toBe(root_id);
    const archive = await f.call('update_message', { root_id, expected_version: 1, status: 'archived', idempotency_key: newId() });
    expect(archive.result.structuredContent.error).toBeUndefined();
    expect(archive.result.structuredContent.status).toBe('archived');
    const restore = await f.call('update_message', { root_id, expected_version: 2, status: 'active', idempotency_key: newId() });
    expect(restore.result.structuredContent.version).toBe(3);
    const thread = await f.call('get_thread', { root_id });
    expect(thread.result.structuredContent.replies).toHaveLength(1);
    const listed = await f.call('list_messages', { project_id: f.projectId, filters: {}, query: 'body' });
    expect(listed.result.structuredContent.items.map((r: { id: string }) => r.id)).toContain(root_id);
    const incremental = await f.call('check_board', { project_id: f.projectId, cursor: initial.result.structuredContent.nextCursor });
    expect(incremental.result.structuredContent.events.length).toBeGreaterThan(0);
    for (const [name, args] of [ ['check_board', { project_id: f.projectId }], ['list_messages', { project_id: f.projectId, filters: {} }], ['get_thread', { root_id }] ] as const) {
      const markdown = await f.call(name, { ...args, format: 'markdown' });
      expect(markdown.result.content[0].text).toMatch(/^# Board/);
      expect(markdown.result.structuredContent).toBeUndefined();
    }
  });
  it('rejects unknown fields and foreign sessions, without echoing injected input', async () => {
    const a = await fixture(); const b = await fixture();
    const injected = await a.call('list_projects', { org_id: b.orgId, author: 'forged' });
    expect(code(injected)).toBe('validation_failed');
    expect(JSON.stringify(injected.result)).not.toContain(b.orgId);
    expect(code(await a.call('list_projects', { session_id: b.session_id }))).toBe('unauthenticated');
    expect(code(await call(a.secret, 'list_projects', {}))).toBe('validation_failed');
  });
  it('denies hidden projects across list, get, post, reply, update and check', async () => {
    const f = await fixture(); const root = (await f.post()).result.structuredContent.id;
    const other = await createProject(f.owner, { name: 'Other', slug: 'other', idempotencyKey: newId() });
    const restricted = await createToken(f.owner, { label: 'restricted', scope: 'projects', projectIds: [other.id] });
    const session_id = (await call(restricted.secret, 'connect_agent', { name: 'restricted' })).result.structuredContent.sessionId;
    const denied = [
      ['list_messages', { project_id: f.projectId, filters: {} }], ['get_thread', { root_id: root }],
      ['post_message', { project_id: f.projectId, title: 'denied', body: 'denied', idempotency_key: newId() }],
      ['reply_message', { root_id: root, body: 'denied', idempotency_key: newId() }],
      ['update_message', { root_id: root, expected_version: 1, urgent: true, idempotency_key: newId() }],
      ['check_board', { project_id: f.projectId }],
    ] as const;
    for (const [name, args] of denied) expect(code(await call(restricted.secret, name, { session_id, ...args })), name).toBe('forbidden_or_not_found');
    const projects = await call(restricted.secret, 'list_projects', { session_id });
    expect(projects.result.structuredContent.projects.map((p: { id: string }) => p.id)).toEqual([other.id]);
    expect(code(await call(restricted.secret, 'create_project', { session_id, name: 'Denied', slug: 'denied', idempotency_key: newId() }))).toBe('capability_denied');
    const capable = await createToken(f.owner, { label: 'capable', scope: 'projects', projectIds: [], canCreateProjects: true });
    const c = (await call(capable.secret, 'connect_agent', { name: 'capable' })).result.structuredContent.sessionId;
    const created = await call(capable.secret, 'create_project', { session_id: c, name: 'Allowed', slug: 'allowed', idempotency_key: newId() });
    expect(created.result.structuredContent.slug).toBe('allowed');
  });
  it('isolates 20 interleaved post-then-read calls from two organizations', async () => {
    const a = await fixture(); const b = await fixture();
    await Promise.all(Array.from({ length: 20 }, async (_, i) => {
      const f = i % 2 ? a : b;
      const posted = await f.post({ title: `interleaved-${i}` });
      expect(posted.result.isError).not.toBe(true);
      const root = posted.result.structuredContent;
      expect(root.orgId).toBe(f.orgId);
      const read = await f.call('get_thread', { root_id: root.id });
      expect(read.result.structuredContent.root.orgId).toBe(f.orgId);
      expect(read.result.structuredContent.root.title).toBe(`interleaved-${i}`);
    }));
  });
  it('revocation and expiration return 401 on the next request with the same session', async () => {
    const f = await fixture();
    expect((await f.call('list_projects')).response.status).toBe(200);
    await revokeToken(f.owner, f.token.id);
    expect((await f.call('list_projects')).response.status).toBe(401);
    const expired = await fixture();
    await admin.db.update(agentTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(agentTokens.id, expired.token.id));
    expect((await expired.call('list_projects')).response.status).toBe(401);
  });
  it('maps suspension without leaking organization metadata', async () => {
    const f = await fixture();
    await admin.db.update(organizations).set({ status: 'suspended' }).where(eq(organizations.id, f.orgId));
    const result = await f.call('list_projects');
    expect(result.response.status).toBe(403);
    expect(code(result)).toBe('org_suspended');
  });
  it('rejects over 64 KiB by observed bytes and declared length before tool operations', async () => {
    const f = await fixture();
    for (const headers of [{}, { 'content-length': '1' }, { 'content-length': String(MAX_BODY_BYTES + 1) }] as Record<string, string>[]) {
      const response = await POST(request(f.secret, ' '.repeat(MAX_BODY_BYTES + 1), headers));
      expect(response.status).toBe(413);
      expect((await response.json()).error.data.code).toBe('content_too_large');
    }
    const operation = vi.spyOn(credentials, 'connectAgent');
    const oversized = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'connect_agent', arguments: { name: 'oversize' } } }).padEnd(MAX_BODY_BYTES + 1);
    expect((await POST(request(f.secret, oversized))).status).toBe(413);
    expect(operation).not.toHaveBeenCalled();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect((await POST(request(f.secret, body.padEnd(MAX_BODY_BYTES)))).status).toBe(200);
    expect((await POST(request(f.secret, '{'))).status).toBe(400);
  });
  it('N+1 concurrent writes commit exactly N with the real default limit', async () => {
    await freshWindow();
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: WRITE_LIMIT + 1 }, () => f.post()));
    expect(results.filter((r) => !r.result.isError)).toHaveLength(WRITE_LIMIT);
    const denied = results.filter((r) => r.result.isError);
    expect(denied).toHaveLength(1);
    expect(code(denied[0]!)).toBe('rate_limited');
    expect(denied[0]!.result.structuredContent.error.details.retryAfterSeconds).toBeGreaterThan(0);
    const rows = await admin.db.select().from(messages).where(eq(messages.orgId, f.orgId));
    expect(rows).toHaveLength(WRITE_LIMIT);
  }, 20000);
  it('limits reads, connect_agent and project creation independently per token', async () => {
    await freshWindow();
    const f = await fixture();
    const p = await authenticateBearer(`Bearer ${f.secret}`, { requestId: newId(), interface: 'mcp' });
    // Use real atomic statements, without time travel or in-memory counters.
    for (let i = 1; i < 120; i++) await checkRateLimit(p, 'read');
    expect(code(await f.call('list_projects'))).toBe('rate_limited');
    expect(code(await call(f.secret, 'connect_agent', { name: 'limited' }))).toBe('rate_limited');
    const g = await fixture();
    for (let i = 0; i < 5; i++) {
      const result = await g.call('create_project', { name: `P${i}`, slug: `p${i}`, idempotency_key: newId() });
      expect(result.result.isError).not.toBe(true);
    }
    expect(code(await g.call('create_project', { name: 'P6', slug: 'p6', idempotency_key: newId() }))).toBe('rate_limited');
    expect((await g.post()).result.isError).not.toBe(true);
  }, 20000);
  it('maps every remaining domain error with details through MCP', async () => {
    const f = await fixture();
    expect(code(await f.call('check_board'))).toBe('no_project_selected');
    const extra = await createProject(f.owner, { name: 'Extra', slug: 'extra', idempotencyKey: newId() });
    const agent = (await call(f.secret, 'connect_agent', { name: 'mcp-agent' })).result.structuredContent.agent.id;
    await setAgentDefaults(f.owner, agent, [f.projectId, extra.id]);
    expect(code(await f.post({ project_id: undefined }))).toBe('ambiguous_project');
    expect(code(await f.call('check_board', { project_id: f.projectId, cursor: 'bad' }))).toBe('invalid_cursor');
    expect(code(await f.post({ body: 'x'.repeat(32769) }))).toBe('content_too_large');
    const key = newId(); const post = await f.post({ idempotency_key: key }); const root_id = post.result.structuredContent.id;
    expect((await f.post({ idempotency_key: key })).result.structuredContent.id).toBe(root_id);
    expect(code(await f.post({ idempotency_key: key, body: 'changed' }))).toBe('idempotency_conflict');
    const conflict = await f.call('update_message', { root_id, expected_version: 99, urgent: true, idempotency_key: newId() });
    expect(code(conflict)).toBe('version_conflict');
    expect(conflict.result.structuredContent.error.details.currentVersion).toBe(1);
    await f.call('update_message', { root_id, expected_version: 1, status: 'archived', idempotency_key: newId() });
    expect(code(await f.call('reply_message', { root_id, body: 'late', idempotency_key: newId() }))).toBe('thread_archived');
    await archiveProject(f.owner, extra.id);
    expect(code(await f.post({ project_id: extra.id }))).toBe('project_archived');
  });
  it('maps injected failures to unavailable and logs prefix, outcome, latency without content', async () => {
    const f = await fixture();
    const body = 'sensitive-body-marker';
    await f.post({ body, title: 'sensitive-title-marker' });
    vi.spyOn(credentials, 'resolveAgentSession').mockRejectedValueOnce(new Error('SQL driver internal detail'));
    expect(code(await f.call('list_projects'))).toBe('unavailable');
    const lines = logger.mock.calls.map(([line]) => String(line));
    const records = lines.map((line) => JSON.parse(line));
    expect(records.some((r) => r.tokenPrefix === f.token.prefix && r.tool === 'post_message' && r.outcome === 'ok')).toBe(true);
    expect(records.some((r) => r.outcome === 'unavailable' && typeof r.latencyMs === 'number' && typeof r.requestId === 'string')).toBe(true);
    const leaked = lines.join('\n').includes(f.secret) || /sensitive-body-marker|sensitive-title-marker|SQL driver/.test(lines.join('\n'));
    expect(leaked).toBe(false);
  });
  it('never trusts an unauthenticated token with a real public prefix', async () => {
    const f = await fixture();
    const invalid = `amb_${f.token.prefix}_${randomBytes(20).toString('hex')}`;
    expect(createHash('sha256').update(invalid).digest('hex')).toHaveLength(64);
    expect((await call(invalid, 'list_projects', { session_id: f.session_id })).response.status).toBe(401);
  });
});
