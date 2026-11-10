import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { POST, GET, DELETE } from '../../../src/app/api/mcp/route';
import { closeDb } from '../../../src/db/client';
import { tenantTableNames } from '../../../src/db/schema';
import { agentTokens } from '../../../src/db/schema/identity';
import { organizations } from '../../../src/db/schema/org';
import * as credentials from '../../../src/domain/credentials';
import { newId, type HumanPrincipal } from '../../../src/domain/kernel';
import { createProject } from '../../../src/domain/projects';
import { WRITE_LIMIT } from '../../../src/domain/ratelimit';
import { adminUrl, openDatabase, runtimeUrl, seedOrg } from '../helpers';

const admin = openDatabase(adminUrl());
const runtime = openDatabase(runtimeUrl());
process.env.DATABASE_URL = runtimeUrl();
process.env.CURSOR_HMAC_SECRET = 's'.repeat(48);
beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await closeDb(); await runtime.pool.end(); await admin.pool.end(); });

async function rpc(secret: string, method: string, params: unknown = {}) {
  const response = await POST(request(secret, JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })));
  const raw = await response.text();
  return { status: response.status, raw, json: JSON.parse(raw) };
}
function request(secret: string, body: string, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/mcp', { method: 'POST', headers: {
    authorization: `Bearer ${secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers,
  }, body });
}
const call = (secret: string, name: string, args: Record<string, unknown>) => rpc(secret, 'tools/call', { name, arguments: args });
type Reply = Awaited<ReturnType<typeof rpc>>;
const data = (r: Reply) => r.json.result?.structuredContent;
const error = (r: Reply) => data(r)?.error ?? r.json.error?.data;
function noLeak(raw: string, markers: string[]) {
  // Boolean assertions prevent synthetic or real credential values entering failure output.
  for (const marker of markers) expect(raw.includes(marker)).toBe(false);
}
async function fixture() {
  const seed = await seedOrg(admin.db, 'security');
  const owner: HumanPrincipal = { kind: 'human', userId: seed.userId, orgId: seed.orgId, siteAdmin: false, interface: 'web', requestId: newId() };
  const issued = await credentials.createToken(owner, { label: 'broad', scope: 'org' });
  const broad = await connection(issued.secret);
  return { ...seed, owner, issued, broad };
}
async function connection(secret: string, name = 'security-agent') {
  const connected = data(await call(secret, 'connect_agent', { name }));
  expect(connected.sessionId).toBeTruthy();
  return { secret, sessionId: connected.sessionId as string, agentId: connected.agent.id as string,
    call: (tool: string, args: Record<string, unknown> = {}) => call(secret, tool, { session_id: connected.sessionId, ...args }) };
}
const post = (c: Awaited<ReturnType<typeof connection>>, projectId: string, extra: Record<string, unknown> = {}) =>
  c.call('post_message', { project_id: projectId, title: 'hidden-title-marker', body: 'hiddenbodymarker', urgent: true, idempotency_key: newId(), ...extra });

test('restricted MCP denials match absent IDs and search counts never reveal hidden content', async () => {
  const f = await fixture();
  const hidden = await createProject(f.owner, { name: 'hidden-project-marker', slug: 'hidden', idempotencyKey: newId() });
  const root = data(await post(f.broad, hidden.id)).id;
  const reply = data(await f.broad.call('reply_message', { root_id: root, body: 'hidden-reply-marker', idempotency_key: newId() })).id;
  const issued = await credentials.createToken(f.owner, { label: 'restricted', scope: 'projects', projectIds: [f.projectId] });
  const c = await connection(issued.secret);
  const cases: Array<[string, (id: string) => Record<string, unknown>, string]> = [
    ['list_messages', id => ({ project_id: id, filters: {}, query: 'hiddenbodymarker' }), hidden.id],
    ['check_board', id => ({ project_id: id }), hidden.id],
    ['post_message', id => ({ project_id: id, title: 'denied', body: 'denied', idempotency_key: newId() }), hidden.id],
    ['get_thread', id => ({ root_id: id }), root],
    ['get_thread', id => ({ root_id: id }), reply],
    ['reply_message', id => ({ root_id: id, body: 'denied', idempotency_key: newId() }), root],
    ['update_message', id => ({ root_id: id, expected_version: 1, urgent: true, idempotency_key: newId() }), root],
  ];
  for (const [tool, args, realId] of cases) {
    const denied = await c.call(tool, args(realId));
    const absent = await c.call(tool, args(newId()));
    expect(error(denied)?.code, tool).toBe('forbidden_or_not_found');
    expect(error(denied), tool).toEqual(error(absent));
    expect(denied.raw, tool).toBe(absent.raw);
    noLeak(denied.raw, [hidden.id, root, reply, hidden.name, 'hidden-title-marker', 'hiddenbodymarker']);
  }
  // Real hidden matching rows exist; the visible project's search must have zero counts.
  const search = await c.call('list_messages', { project_id: f.projectId, filters: {}, query: 'hiddenbodymarker' });
  expect(data(search).totalCount).toBe(0); expect(data(search).items).toEqual([]);
  const listed = await c.call('list_projects');
  expect(data(listed).projects.map((p: { id: string }) => p.id)).toEqual([f.projectId]);
  noLeak(search.raw + listed.raw, [hidden.id, hidden.name, root, 'hidden-title-marker', 'hiddenbodymarker']);
  // Owner-assigned defaults are real but never confer a grant.
  await credentials.setAgentDefaults(f.owner, c.agentId, [hidden.id]);
  const defaultCheck = await c.call('check_board');
  expect(error(defaultCheck).code).toBe('no_project_selected');
  noLeak(defaultCheck.raw, [hidden.id, hidden.name, root]);
  const newProject = await createProject(f.owner, { name: 'After token', slug: 'after-token', idempotencyKey: newId() });
  expect(data(await f.broad.call('list_projects')).projects.map((p: { id: string }) => p.id)).toContain(newProject.id);
});

test('cursor and continuation replay reject another token, another org, removed grants and byte tampering', async () => {
  const f = await fixture();
  const hidden = await createProject(f.owner, { name: 'cursor-hidden-project', slug: 'cursor-hidden', idempotencyKey: newId() });
  const hiddenRoot = data(await post(f.broad, hidden.id)).id;
  await post(f.broad, f.projectId); await post(f.broad, f.projectId);
  const a = await credentials.createToken(f.owner, { label: 'A', scope: 'projects', projectIds: [f.projectId, hidden.id] });
  const b = await credentials.createToken(f.owner, { label: 'B', scope: 'projects', projectIds: [f.projectId] });
  const ca = await connection(a.secret); const cb = await connection(b.secret); const foreign = await fixture();
  const initial = data(await ca.call('check_board', { project_id: f.projectId, limit: 1 }));
  const continuation = initial.groups.urgent.continuation;
  expect(typeof continuation).toBe('string'); expect(continuation.length).toBeGreaterThan(0);
  for (const [field, value] of [['cursor', initial.nextCursor], ['continuation', continuation]] as const) {
    // Positive controls: each original token is usable by its issuer.
    expect(error(await ca.call('check_board', { project_id: f.projectId, [field]: value }))).toBeUndefined();
    const tampered = (value[0] === 'A' ? 'B' : 'A') + value.slice(1);
    for (const [c, project, token] of [[cb, f.projectId, value], [foreign.broad, foreign.projectId, value], [ca, f.projectId, tampered]] as const) {
      const denied = await c.call('check_board', { project_id: project, [field]: token });
      expect(error(denied)?.code).toBe('invalid_cursor');
      expect(error(denied)?.details.resync).toContain('fresh board check');
      noLeak(denied.raw, [hiddenRoot, hidden.id, 'hidden-title-marker', 'hiddenbodymarker']);
    }
  }
  await credentials.setTokenGrants(f.owner, a.token.id, [f.projectId]);
  for (const field of ['cursor', 'continuation'] as const) {
    const denied = await ca.call('check_board', { project_id: f.projectId, [field]: field === 'cursor' ? initial.nextCursor : continuation });
    expect(error(denied)?.code).toBe('invalid_cursor');
    expect(error(denied)?.details.resync).toContain('fresh board check');
    noLeak(denied.raw, [hiddenRoot, hidden.id, 'hiddenbodymarker']);
  }
});

test('grant removal denies the next MCP request on the same session', async () => {
  const f = await fixture();
  const issued = await credentials.createToken(f.owner, { label: 'grant', scope: 'projects', projectIds: [f.projectId] });
  const c = await connection(issued.secret);
  expect(error(await c.call('check_board', { project_id: f.projectId }))).toBeUndefined();
  await credentials.setTokenGrants(f.owner, issued.token.id, []);
  const denied = await c.call('check_board', { project_id: f.projectId });
  expect(error(denied).code).toBe('forbidden_or_not_found'); noLeak(denied.raw, [f.projectId]);
});

test('revocation expiry and suspension deny the next successful session request', async () => {
  for (const mode of ['revoke', 'expire', 'suspend']) {
    const f = await fixture();
    expect(error(await f.broad.call('list_projects'))).toBeUndefined();
    if (mode === 'revoke') await credentials.revokeToken(f.owner, f.issued.token.id);
    if (mode === 'expire') await admin.db.update(agentTokens).set({ expiresAt: new Date(0) }).where(eq(agentTokens.id, f.issued.token.id));
    if (mode === 'suspend') await admin.db.update(organizations).set({ status: 'suspended' }).where(eq(organizations.id, f.orgId));
    const denied = await f.broad.call('list_projects');
    expect(denied.status).toBe(mode === 'suspend' ? 403 : 401);
    expect(error(denied).code).toBe(mode === 'suspend' ? 'org_suspended' : 'unauthenticated');
    noLeak(denied.raw, [f.projectId, f.orgId]);
  }
});

test('non-domain tool failures are private in the entire raw HTTP response', async () => {
  const f = await fixture();
  const internal = new Error('INTERNAL_SECURITY_MARKER relation private_table syntax error pg /private/internal/driver.ts');
  internal.stack = 'Error: INTERNAL_SECURITY_MARKER\n    at driver (/private/internal/driver.ts:1:2)';
  vi.spyOn(credentials, 'resolveAgentSession').mockRejectedValueOnce(internal);
  const denied = await f.broad.call('list_projects');
  expect(error(denied).code).toBe('unavailable');
  noLeak(denied.raw, ['INTERNAL_SECURITY_MARKER', 'at ', 'relation', 'syntax error', 'pg', '/private/', 'driver.ts']);
});

test('HTTP protocol failures never echo input or internal diagnostics in raw responses', async () => {
  const f = await fixture();
  const marker = 'HTTP_SECURITY_MARKER relation syntax error pg /private/internal.ts at driver';
  const responses = [
    await POST(request(f.issued.secret, `{${marker}`)),
    await POST(request(f.issued.secret, JSON.stringify({ jsonrpc: '2.0', id: 1, method: marker }), { 'content-type': 'text/plain' })),
    await POST(request(f.issued.secret, JSON.stringify([{ jsonrpc: '2.0', id: 1, method: marker }]))),
    await POST(request(f.issued.secret, marker.padEnd(65537))),
    await GET(new Request('http://localhost/api/mcp', { headers: { authorization: `Bearer ${f.issued.secret}` } })),
    await DELETE(new Request('http://localhost/api/mcp', { method: 'DELETE', headers: { authorization: `Bearer ${f.issued.secret}` } })),
  ];
  // The official stateless SDK accepts batch envelopes/DELETE with HTTP 200.
  // Privacy is asserted on all raw bodies, including empty protocol responses.
  expect(responses.map(r => r.status)).toEqual([400, 415, 200, 413, 406, 200]);
  for (const response of responses) {
    // JSON-RPC protocol errors may use HTTP 200; the complete response must be private.
    const raw = await response.text();
    if (raw) {
      const parsed = JSON.parse(raw);
      expect(Array.isArray(parsed) ? parsed.every(r => !!r.error) : !!parsed.error).toBe(true);
    }
    noLeak(raw, ['HTTP_SECURITY_MARKER', 'at ', 'relation', 'syntax error', 'pg', '/private/', f.issued.secret]);
  }
});

test('all MCP tool logs exclude bearer values, titles and bodies', async () => {
  const logs = vi.mocked(console.log);
  const f = await fixture();
  const root = data(await post(f.broad, f.projectId)).id;
  for (const [tool, args] of [
    ['list_projects', {}], ['check_board', { project_id: f.projectId }],
    ['list_messages', { project_id: f.projectId, filters: {}, query: 'hiddenbodymarker' }], ['get_thread', { root_id: root }],
    ['reply_message', { root_id: root, body: 'reply-private-body', idempotency_key: newId() }],
    ['update_message', { root_id: root, expected_version: 1, pinned: true, idempotency_key: newId() }],
    ['create_project', { name: 'private-project-title', slug: 'log-project', idempotency_key: newId() }],
  ] as const) expect(error(await f.broad.call(tool, args))).toBeUndefined();
  const records = logs.mock.calls.map(([line]) => JSON.parse(String(line)));
  expect(new Set(records.map(r => r.tool)).size).toBe(9);
  const raw = logs.mock.calls.map(([line]) => String(line)).join('\n');
  noLeak(raw, [f.issued.secret, `Bearer ${f.issued.secret}`, 'hidden-title-marker', 'hiddenbodymarker', 'reply-private-body', 'private-project-title']);
  expect(/amb_[A-Za-z0-9]{8}_[A-Za-z0-9]{40}/.test(raw)).toBe(false);
});

test('one token at its write limit does not throttle a sibling token', async () => {
  const f = await fixture();
  const b = await credentials.createToken(f.owner, { label: 'sibling', scope: 'org' }); const cb = await connection(b.secret);
  // Seed the current AND next fixed windows to avoid a wall-clock boundary flake.
  await admin.pool.query(`insert into rate_limit_windows (org_id, token_id, bucket, window_start, count)
    select $1, $2, 'write', date_trunc('minute', clock_timestamp()) + n * interval '1 minute', $3
    from generate_series(0, 1) n`, [f.orgId, f.issued.token.id, WRITE_LIMIT]);
  expect(error(await post(f.broad, f.projectId)).code).toBe('rate_limited');
  expect(error(await post(cb, f.projectId))).toBeUndefined();
});

test('tenant catalog has at least one policy per tenant table under the real runtime role', async () => {
  const role = (await runtime.pool.query('select rolsuper, rolbypassrls from pg_roles where rolname=current_user')).rows[0];
  expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
  const policies = (await runtime.pool.query("select tablename from pg_policies where schemaname='public'")).rows.map(r => r.tablename);
  for (const name of tenantTableNames) expect(policies, name).toContain(name);
});

test('tools list names are exactly the nine matrix operations and privileged operations are absent', async () => {
  const f = await fixture();
  const listed = await rpc(f.issued.secret, 'tools/list');
  expect(listed.json.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
    'check_board', 'connect_agent', 'create_project', 'get_thread', 'list_messages', 'list_projects', 'post_message', 'reply_message', 'update_message',
  ]);
  for (const name of ['create_organization', 'create_token', 'revoke_token', 'replace_token', 'set_token_grants', 'set_agent_defaults', 'edit_announcements', 'archive_project', 'suspend_organization']) {
    expect(error(await f.broad.call(name)).code).toBe('validation_failed');
  }
  const forged = await post(f.broad, f.projectId, { author_user_id: f.userId });
  expect(error(forged).code).toBe('validation_failed'); noLeak(forged.raw, [f.userId]);
});

test('restricted token executes all nine tools within grants and revoked or expired tokens execute none', async () => {
  const f = await fixture();
  const issued = await credentials.createToken(f.owner, { label: 'capable restricted', scope: 'projects', projectIds: [f.projectId], canCreateProjects: true });
  const c = await connection(issued.secret);
  const root = data(await post(c, f.projectId)).id;
  const operations: Array<[string, Record<string, unknown>]> = [
    ['connect_agent', { name: 'matrix-agent' }], ['list_projects', {}],
    ['create_project', { name: 'Restricted created', slug: 'restricted-created', idempotency_key: newId() }],
    ['check_board', { project_id: f.projectId }], ['list_messages', { project_id: f.projectId, filters: {} }],
    ['get_thread', { root_id: root }],
    ['post_message', { project_id: f.projectId, title: 'Allowed', body: 'Allowed', idempotency_key: newId() }],
    ['reply_message', { root_id: root, body: 'Allowed', idempotency_key: newId() }],
    ['update_message', { root_id: root, expected_version: 1, urgent: false, idempotency_key: newId() }],
  ];
  for (const [tool, args] of operations) {
    const result = tool === 'connect_agent' ? await call(c.secret, tool, args) : await c.call(tool, args);
    expect(error(result), tool).toBeUndefined();
  }
  for (const mode of ['revoke', 'expire']) {
    const dead = mode === 'revoke' ? issued : await credentials.createToken(f.owner, { label: 'expire', scope: 'org' });
    const connected = mode === 'revoke' ? c : await connection(dead.secret);
    if (mode === 'revoke') await credentials.revokeToken(f.owner, dead.token.id);
    else await admin.db.update(agentTokens).set({ expiresAt: new Date(0) }).where(eq(agentTokens.id, dead.token.id));
    for (const [tool, args] of operations) {
      const denied = await call(dead.secret, tool, tool === 'connect_agent' ? args : { ...args, session_id: connected.sessionId });
      expect(denied.status, tool).toBe(401); expect(error(denied).code, tool).toBe('unauthenticated');
      noLeak(denied.raw, [root, f.projectId, dead.secret]);
    }
  }
});
