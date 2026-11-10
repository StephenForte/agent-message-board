import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createToken } from '../../../src/domain/credentials';
import { newId } from '../../../src/domain/kernel';
import { closeDb, seedOwner, seedProject } from '../board/helpers';

test.afterAll(async () => { await closeDb(); });
test('official SDK collaborates through the production stateless endpoint', async () => {
  const owner = await seedOwner();
  const project = await seedProject(owner);
  const issued = await createToken(owner.principal(), { label: 'SDK smoke', scope: 'org' });
  const clients: Client[] = [];
  async function connect(name: string) {
    const client = new Client({ name: 'T11 smoke', version: '1.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3100/api/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${issued.secret}` } },
    }));
    const result = await client.callTool({ name: 'connect_agent', arguments: { name } }) as CallToolResult;
    expect(result.isError).not.toBe(true);
    const session_id = result.structuredContent!.sessionId;
    return { client, session_id };
  }
  try {
    const first = await connect('sdk-first');
    const run = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await first.client.callTool({ name, arguments: { session_id: first.session_id, ...args } }) as CallToolResult;
      expect(result.isError).not.toBe(true);
      return result.structuredContent!;
    };
    const initial = await run('check_board', { project_id: project.id });
    const root = await run('post_message', { project_id: project.id, title: 'SDK handoff', body: 'Ready for the second agent.',
      category: 'handoff', pinned: true, idempotency_key: newId() });
    const reply = await run('reply_message', { root_id: root.id, body: 'Follow-up evidence.', idempotency_key: newId() });
    expect(reply.rootId).toBe(root.id);
    const archived = await run('update_message', { root_id: root.id, expected_version: 1, status: 'archived', idempotency_key: newId() });
    expect(archived.status).toBe('archived');
    const restored = await run('update_message', { root_id: root.id, expected_version: 2, status: 'active', idempotency_key: newId() });
    expect(restored.status).toBe('active');
    const incremental = await run('check_board', { project_id: project.id, cursor: initial.nextCursor });
    expect((incremental.events as unknown[]).length).toBeGreaterThan(0);
    const listed = await run('list_messages', { project_id: project.id, filters: {}, query: 'handoff' });
    expect((listed.items as { id: string }[]).map((item) => item.id)).toContain(root.id);
    const second = await connect('sdk-second');
    const board = await second.client.callTool({ name: 'check_board', arguments: { session_id: second.session_id, project_id: project.id } }) as CallToolResult;
    expect(board.isError).not.toBe(true);
    expect((board.structuredContent!.items as { threadId: string }[]).map((item) => item.threadId)).toContain(root.id);
  } finally { await Promise.all(clients.map((client) => client.close())); }
});
