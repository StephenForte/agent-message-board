import { randomBytes } from 'node:crypto';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { inject } from 'vitest';
import * as schema from '../../src/db/schema/index';
import { newId } from '../../src/domain/kernel/ids';
import type { AgentPrincipal, SystemPrincipal } from '../../src/domain/kernel/principal';

export type TestDatabase = NodePgDatabase<typeof schema>;

export function adminUrl(): string {
  return inject('databaseUrl');
}

export function runtimeUrl(): string {
  return inject('runtimeDatabaseUrl');
}

export function openDatabase(url: string, max = 4): { pool: pg.Pool; db: TestDatabase } {
  const pool = new pg.Pool({ connectionString: url, max, connectionTimeoutMillis: 5_000 });
  return { pool, db: drizzle(pool, { schema }) };
}

export function tokenPrefix(): string {
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const bytes = randomBytes(8);
  let out = '';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

export function sha256Hex(): string {
  return randomBytes(32).toString('hex');
}

export async function seedOrg(db: TestDatabase, name: string) {
  const userId = newId();
  const orgId = newId();
  const projectId = newId();
  const tokenId = newId();
  const agentId = newId();
  const sessionId = newId();
  const prefix = tokenPrefix();
  const tokenHash = sha256Hex();
  await db.insert(schema.user).values({
    id: userId,
    name: 'Owner',
    email: `${name}-${userId}@example.com`,
    emailVerified: true,
  });
  await db.insert(schema.organizations).values({
    id: orgId,
    name,
    ownerUserId: userId,
    status: 'active',
  });
  await db.insert(schema.agentTokens).values({
    id: tokenId,
    orgId,
    label: 'primary',
    prefix,
    tokenHash,
    scope: 'projects',
    canCreateProjects: false,
    createdByUserId: userId,
  });
  await db.insert(schema.agents).values({ id: agentId, orgId, name: 'worker' });
  await db.insert(schema.projects).values({
    id: projectId,
    orgId,
    slug: 'alpha',
    name: 'Alpha',
    status: 'active',
    createdByKind: 'human',
    createdByUserId: userId,
  });
  await db.insert(schema.agentSessions).values({
    id: sessionId,
    orgId,
    agentId,
    tokenId,
    clientLabel: 'test',
  });
  await db.insert(schema.tokenProjectGrants).values({
    orgId,
    tokenId,
    projectId,
    source: 'owner',
  });
  return { userId, orgId, projectId, tokenId, agentId, sessionId, prefix, tokenHash };
}

export function systemPrincipal(orgId: string, requestId = 'req-system'): SystemPrincipal {
  return { kind: 'system', orgId, interface: 'cli', requestId };
}

export function agentPrincipal(seed: {
  orgId: string;
  tokenId: string;
  projectId: string;
  agentId: string;
  sessionId: string;
}, requestId = 'req-agent'): AgentPrincipal {
  return {
    kind: 'agent',
    orgId: seed.orgId,
    tokenId: seed.tokenId,
    scope: 'projects',
    projectIds: [seed.projectId],
    canCreateProjects: false,
    agentId: seed.agentId,
    sessionId: seed.sessionId,
    interface: 'mcp',
    requestId,
  };
}

export async function insertRoot(db: TestDatabase, seed: { orgId: string; projectId: string; userId: string }, title: string) {
  const id = newId();
  await db.insert(schema.messages).values({
    id,
    orgId: seed.orgId,
    projectId: seed.projectId,
    title,
    body: `body ${title}`,
    category: 'note',
    status: 'active',
    urgent: false,
    pinned: false,
    version: 1,
    lastActivityAt: new Date(),
    authorKind: 'human',
    authorUserId: seed.userId,
    authorDisplayName: 'Owner',
  });
  return id;
}
