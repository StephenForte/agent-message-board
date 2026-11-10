import { createWriteStream, existsSync, readFileSync, writeFileSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sleep } from './scratch';
import { READS_PER_MINUTE, WRITES_PER_MINUTE, type LoadAgent, type LoadManifest, type LoadOrg, type ToolName } from './types';

type CallResult = { isError?: boolean; structuredContent?: unknown };

type AgentRun = {
  org: LoadOrg;
  agent: LoadAgent;
  client: Client;
  sessionId: string;
  roots: string[];
  peerId: string | null;
  cursor?: string;
  listCursor?: string;
  version: number;
  urgent: boolean;
  posted: string[];
  replyCursors: Map<string, string>;
  op: number;
};

const categories = ['note', 'finding', 'decision', 'blocker', 'handoff'] as const;
const readTools = ['check_board', 'list_messages', 'get_thread', 'check_board'] as const;
const writeTools = ['post_message', 'reply_message', 'update_message'] as const;

function manifestFromEnv(): LoadManifest {
  const path = process.env.MANIFEST_PATH;
  if (!path) throw new Error('MANIFEST_PATH is required');
  return JSON.parse(readFileSync(path, 'utf8')) as LoadManifest;
}

function record(stream: WriteStream, tool: string, ms: number, ok: boolean, code: string | null): void {
  stream.write(`${JSON.stringify({ tool, ms: Math.round(ms * 100) / 100, ok, code, at: Date.now() })}\n`);
}

function payload(result: CallResult): { ok: boolean; code: string | null; data: Record<string, unknown> } {
  const data = result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)
    ? result.structuredContent as Record<string, unknown> : {};
  if (!result.isError) return { ok: true, code: null, data };
  const error = data.error;
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'unknown';
  return { ok: false, code, data };
}

function transportCode(error: unknown): string {
  if (typeof error === 'object' && error && 'code' in error && typeof error.code === 'number' && error.code >= 500) return 'http_5xx';
  return 'transport';
}

async function callTool(stream: WriteStream, client: Client, tool: ToolName, args: Record<string, unknown>): Promise<{ ok: boolean; code: string | null; data: Record<string, unknown> }> {
  const started = performance.now();
  try {
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 }) as CallResult;
    const body = payload(result);
    record(stream, tool, performance.now() - started, body.ok, body.code);
    return body;
  } catch (error) {
    const code = transportCode(error);
    record(stream, tool, performance.now() - started, false, code);
    return { ok: false, code, data: {} };
  }
}

async function connectAgent(stream: WriteStream, endpoint: string, org: LoadOrg, agent: LoadAgent): Promise<AgentRun> {
  const client = new Client({ name: 't15-load', version: '1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${agent.secret}` } },
  }));
  const connected = await callTool(stream, client, 'connect_agent', { name: agent.name, client_label: 't15-steady' });
  const sessionId = connected.data.sessionId;
  if (!connected.ok || typeof sessionId !== 'string') throw new Error(`connect_agent failed for ${agent.name} (${connected.code ?? 'no-session'})`);
  const project = org.projects.find((item) => item.id === agent.listProjectId);
  const peer = org.agents.find((item) => item.agentId !== agent.agentId);
  return {
    org, agent, client, sessionId, roots: project?.rootIds ?? [], peerId: peer?.agentId ?? null,
    version: agent.updateVersion, urgent: agent.updateUrgent, posted: [], replyCursors: new Map(), op: 0,
  };
}

function noteVersion(run: AgentRun, data: Record<string, unknown>): void {
  if (typeof data.version === 'number') run.version = data.version;
  if (typeof data.urgent === 'boolean') run.urgent = data.urgent;
  const error = data.error;
  if (!error || typeof error !== 'object' || !('details' in error)) return;
  const details = error.details;
  if (details && typeof details === 'object' && 'currentVersion' in details && typeof details.currentVersion === 'number') {
    run.version = details.currentVersion;
  }
}

async function readOp(stream: WriteStream, run: AgentRun): Promise<void> {
  const tool = readTools[run.op % readTools.length]!;
  if (tool === 'check_board') {
    const args: Record<string, unknown> = { session_id: run.sessionId };
    if (run.cursor) args.cursor = run.cursor;
    const result = await callTool(stream, run.client, tool, args);
    if (result.ok && typeof result.data.nextCursor === 'string') run.cursor = result.data.nextCursor;
    if (result.code === 'invalid_cursor') run.cursor = undefined;
    return;
  }
  if (tool === 'list_messages') {
    const args: Record<string, unknown> = { session_id: run.sessionId, project_id: run.agent.listProjectId, filters: {} };
    if (run.listCursor) args.cursor = run.listCursor;
    const result = await callTool(stream, run.client, tool, args);
    if (result.code === 'invalid_cursor') run.listCursor = undefined;
    if (!result.ok) return;
    if (typeof result.data.nextCursor === 'string') run.listCursor = result.data.nextCursor;
    else run.listCursor = undefined;
    return;
  }
  const pool = run.posted.length > 0 ? run.posted : run.roots;
  const rootId = pool[run.op % pool.length] ?? run.agent.updateRootId;
  const args: Record<string, unknown> = { session_id: run.sessionId, root_id: rootId };
  const replyCursor = run.replyCursors.get(rootId);
  if (replyCursor) args.reply_cursor = replyCursor;
  const result = await callTool(stream, run.client, 'get_thread', args);
  if (!result.ok) return;
  if (typeof result.data.nextReplyCursor === 'string') run.replyCursors.set(rootId, result.data.nextReplyCursor);
  else run.replyCursors.delete(rootId);
}

async function writeOp(stream: WriteStream, run: AgentRun): Promise<void> {
  const tool = writeTools[run.op % writeTools.length]!;
  if (tool === 'post_message') {
    const projectId = run.agent.writableProjectIds[run.op % run.agent.writableProjectIds.length]!;
    const args: Record<string, unknown> = {
      session_id: run.sessionId, project_id: projectId,
      title: `Steady ${run.op}`, body: `Steady-run note ${run.op} from ${run.agent.name}.`,
      category: categories[run.op % categories.length], idempotency_key: randomUUID(),
    };
    if (run.peerId && run.op % 4 === 0) args.recipients = [run.peerId];
    const result = await callTool(stream, run.client, tool, args);
    if (result.ok && typeof result.data.id === 'string') run.posted.push(result.data.id);
    return;
  }
  if (tool === 'reply_message') {
    const pool = run.roots.length > 0 ? run.roots : run.posted;
    const rootId = pool[run.op % pool.length] ?? run.agent.updateRootId;
    await callTool(stream, run.client, tool, {
      session_id: run.sessionId, root_id: rootId, body: `Steady reply ${run.op} from ${run.agent.name}.`, idempotency_key: randomUUID(),
    });
    return;
  }
  const result = await callTool(stream, run.client, 'update_message', {
    session_id: run.sessionId, root_id: run.agent.updateRootId, expected_version: run.version,
    urgent: !run.urgent, idempotency_key: randomUUID(),
  });
  noteVersion(run, result.data);
}

async function pace(run: AgentRun, stream: WriteStream, stopMs: number, stopFile: string): Promise<void> {
  const pattern = ['read', 'read', 'read', 'read', 'write'] as const;
  let patternIndex = 0;
  let minute = Math.floor(Date.now() / 60_000);
  let reads = 0;
  let writes = 0;
  let nextAt = Date.now();
  while (Date.now() < stopMs && !existsSync(stopFile)) {
    const kind = pattern[patternIndex % pattern.length]!;
    const delay = nextAt - Date.now();
    if (delay > 0) await sleep(delay);
    if (Date.now() >= stopMs || existsSync(stopFile)) return;
    const nowMinute = Math.floor(Date.now() / 60_000);
    if (nowMinute !== minute) { minute = nowMinute; reads = 0; writes = 0; }
    if (kind === 'read' && reads >= READS_PER_MINUTE) { nextAt = (nowMinute + 1) * 60_000 + 20; continue; }
    if (kind === 'write' && writes >= WRITES_PER_MINUTE) { nextAt = (nowMinute + 1) * 60_000 + 20; continue; }
    if (kind === 'read') reads += 1;
    else writes += 1;
    patternIndex += 1;
    const started = Date.now();
    if (kind === 'read') await readOp(stream, run);
    else await writeOp(stream, run);
    run.op += 1;
    nextAt = Math.max(started + 500, Date.now());
  }
}

function watchCpu(): { stop: () => { maxCpuPercent: number; maxEventLoopLagMs: number } } {
  const samples: number[] = [];
  let lastCpu = process.cpuUsage();
  let lastWall = process.hrtime.bigint();
  const cpuTimer = setInterval(() => {
    const cpu = process.cpuUsage(lastCpu);
    const wallMs = Number(process.hrtime.bigint() - lastWall) / 1e6;
    lastCpu = process.cpuUsage();
    lastWall = process.hrtime.bigint();
    if (wallMs > 0) samples.push(((cpu.user + cpu.system) / 1000) / wallMs * 100);
  }, 5_000);
  let expected = Date.now() + 1_000;
  const lags: number[] = [];
  const lagTimer = setInterval(() => {
    const now = Date.now();
    lags.push(Math.max(0, now - expected));
    expected = now + 1_000;
  }, 1_000);
  return { stop: () => {
    clearInterval(cpuTimer);
    clearInterval(lagTimer);
    return {
      maxCpuPercent: samples.reduce((max, sample) => Math.max(max, sample), 0),
      maxEventLoopLagMs: lags.reduce((max, sample) => Math.max(max, sample), 0),
    };
  } };
}

async function steady(): Promise<void> {
  const manifest = manifestFromEnv();
  const runDir = process.env.RUN_DIR;
  const endpoint = process.env.ENDPOINT;
  const workerIndex = Number(process.env.WORKER_INDEX ?? '0');
  const workersPerOrg = Number(process.env.WORKERS_PER_ORG ?? '1');
  if (!runDir || !endpoint) throw new Error('RUN_DIR and ENDPOINT are required');
  const orgIndex = Math.floor(workerIndex / workersPerOrg);
  const part = workerIndex % workersPerOrg;
  const org = manifest.orgs[orgIndex];
  if (!org) return;
  const agents = org.agents.filter((_, index) => index % workersPerOrg === part);
  const stream = createWriteStream(join(runDir, `timing-${workerIndex}.jsonl`), { flags: 'a' });
  const watcher = watchCpu();
  const runs: AgentRun[] = [];
  try {
    for (const agent of agents) runs.push(await connectAgent(stream, endpoint, org, agent));
    writeFileSync(join(runDir, `ready-${workerIndex}`), 'ready');
    const goPath = join(runDir, 'go.json');
    let go: { startMs: number; stopMs: number } | undefined;
    while (!go) {
      if (existsSync(goPath)) go = JSON.parse(readFileSync(goPath, 'utf8')) as { startMs: number; stopMs: number };
      else await sleep(100);
    }
    const delay = go.startMs - Date.now();
    if (delay > 0) await sleep(delay);
    const stopFile = join(runDir, 'stop');
    await Promise.all(runs.map((run) => pace(run, stream, go.stopMs, stopFile)));
  } finally {
    const meta = watcher.stop();
    writeFileSync(join(runDir, `worker-${workerIndex}-meta.json`), JSON.stringify({ workerIndex, agents: agents.length, ...meta }));
    await Promise.all(runs.map(async (run) => { await run.client.close().catch(() => undefined); }));
    await new Promise<void>((resolve) => stream.end(resolve));
  }
}

async function finalCheck(): Promise<void> {
  const manifest = manifestFromEnv();
  const runDir = process.env.RUN_DIR;
  const endpoint = process.env.ENDPOINT;
  if (!runDir || !endpoint) throw new Error('RUN_DIR and ENDPOINT are required');
  const stream = createWriteStream(join(runDir, 'timing-final.jsonl'), { flags: 'a' });
  const results = [];
  try {
    for (const org of manifest.orgs) {
      const agent = org.agents[0];
      if (!agent) continue;
      const run = await connectAgent(stream, endpoint, org, agent);
      const started = performance.now();
      const result = await callTool(stream, run.client, 'check_board', { session_id: run.sessionId });
      const clientMs = Math.round(performance.now() - started);
      const announcements = result.data.announcements;
      const pair = announcements && typeof announcements === 'object' ? announcements as { site?: unknown; org?: unknown } : {};
      results.push({
        orgId: org.orgId, ok: result.ok, code: result.code, clientMs,
        cursor: typeof result.data.nextCursor === 'string' && result.data.nextCursor.length > 0,
        site: pair.site != null, org: pair.org != null,
      });
      await run.client.close().catch(() => undefined);
    }
  } finally {
    await new Promise<void>((resolve) => stream.end(resolve));
  }
  writeFileSync(join(runDir, 'final.json'), JSON.stringify(results));
}

async function main(): Promise<void> {
  if (process.env.MODE === 'final') await finalCheck();
  else await steady();
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'worker failed';
    console.error(message.replace(/amb_[A-Za-z0-9]+_[A-Za-z0-9]+/g, '[redacted]').replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]'));
    process.exit(1);
  });
}
