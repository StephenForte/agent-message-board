import { chmodSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { and, eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import { closeDb, getDb } from '../src/db/client';
import { user } from '../src/db/schema/auth';
import { messages, messageRecipients } from '../src/db/schema/messages';
import { organizations } from '../src/db/schema/org';
import { auditRecords } from '../src/db/schema/ops';
import { siteAdmins } from '../src/db/schema/site-admins';
import { setOrgAnnouncement, setSiteAnnouncement } from '../src/domain/announcements';
import { setupAgentConnection } from '../src/domain/credentials';
import { appendEvents, newId, withOrgBootstrapTx, withOrgTx, type HumanPrincipal } from '../src/domain/kernel';
import { createProject } from '../src/domain/projects';
import { createLoadDatabase, dropLoadDatabase, ownerUrl } from './database';
import { gitCommit, scratchDir } from './scratch';
import type { LoadAgent, LoadManifest, LoadOrg } from './types';

const categories = ['note', 'finding', 'decision', 'blocker', 'handoff'] as const;
type Category = (typeof categories)[number];

export type Envelope = {
  smoke: boolean;
  orgs: number;
  projectsPerOrg: number;
  agentsPerOrg: number;
  messages: number;
};

export const FULL_ENVELOPE: Envelope = {
  smoke: false, orgs: 10, projectsPerOrg: 100, agentsPerOrg: 20, messages: 100_000,
};
export const SMOKE_ENVELOPE: Envelope = {
  smoke: true, orgs: 1, projectsPerOrg: 2, agentsPerOrg: 2, messages: 20,
};

const BATCH = 100;

function principal(userId: string, orgId: string): HumanPrincipal {
  return { kind: 'human', userId, orgId, role: orgId ? 'owner' : null, siteAdmin: false, interface: 'web', requestId: newId() };
}

type PlannedRoot = {
  id: string;
  projectId: string;
  title: string;
  body: string;
  category: Category;
  urgent: boolean;
  pinned: boolean;
  recipientAgentId: string | null;
};

function planRoots(projectIds: string[], agentIds: string[], count: number, orgIndex: number): PlannedRoot[] {
  const roots: PlannedRoot[] = [];
  for (let i = 0; i < count; i++) {
    const projectId = projectIds[i % projectIds.length]!;
    roots.push({
      id: newId(),
      projectId,
      title: `Seed root ${orgIndex}-${i}`,
      body: `Seeded root ${i} for the pilot envelope. Coordination note only.`,
      category: categories[i % categories.length]!,
      urgent: i % 20 === 0,
      pinned: i % 17 === 0,
      recipientAgentId: i % 10 === 0 ? agentIds[i % agentIds.length]! : null,
    });
  }
  return roots;
}

async function insertRoots(orgId: string, userId: string, ownerName: string, roots: PlannedRoot[]): Promise<void> {
  const db = getDb();
  for (let offset = 0; offset < roots.length; offset += BATCH) {
    const batch = roots.slice(offset, offset + BATCH);
    await withOrgTx(principal(userId, orgId), async (tx, ctx) => {
      await tx.insert(messages).values(batch.map((root) => ({
        id: root.id, orgId, projectId: root.projectId, title: root.title, body: root.body,
        category: root.category, urgent: root.urgent, pinned: root.pinned, status: 'active', version: 1,
        lastActivityAt: new Date(), authorKind: 'human', authorUserId: userId, authorDisplayName: ownerName,
      })));
      const recipients = batch.filter((root) => root.recipientAgentId);
      if (recipients.length) {
        await tx.insert(messageRecipients).values(recipients.map((root) => ({
          orgId, messageId: root.id, agentId: root.recipientAgentId!,
        })));
      }
      await appendEvents(tx, ctx.orgId, batch.map((root) => ({
        kind: 'message.created' as const, projectId: root.projectId, messageId: root.id, rootId: root.id,
        payload: { status: 'active', urgent: root.urgent, pinned: root.pinned, version: 1 },
      })));
      await tx.insert(auditRecords).values(batch.map((root) => ({
        id: newId(), orgId, actorKind: 'human' as const, userId, interfaceKind: 'web' as const,
        requestId: newId(), action: 'message.created', entityType: 'message', entityId: root.id,
        after: { status: 'active', urgent: root.urgent, pinned: root.pinned, version: 1, category: root.category },
      })));
    }, db);
  }
}

async function insertReplies(orgId: string, userId: string, ownerName: string, roots: PlannedRoot[], agentIds: string[]): Promise<number> {
  const db = getDb();
  let replies = 0;
  for (let offset = 0; offset < roots.length; offset += BATCH) {
    const batch = roots.slice(offset, offset + BATCH);
    const rows = batch.map((root, index) => ({
      id: newId(),
      root,
      body: `Seeded reply ${offset + index} on ${root.title}.`,
      recipientAgentId: (offset + index) % 10 === 3 ? agentIds[(offset + index) % agentIds.length]! : null,
    }));
    await withOrgTx(principal(userId, orgId), async (tx, ctx) => {
      await tx.insert(messages).values(rows.map((row) => ({
        id: row.id, orgId, projectId: row.root.projectId, rootId: row.root.id, body: row.body,
        authorKind: 'human', authorUserId: userId, authorDisplayName: ownerName,
      })));
      const recipients = rows.filter((row) => row.recipientAgentId);
      if (recipients.length) {
        await tx.insert(messageRecipients).values(recipients.map((row) => ({
          orgId, messageId: row.id, agentId: row.recipientAgentId!,
        })));
      }
      await tx.update(messages).set({
        lastActivityAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()`,
      }).where(and(eq(messages.orgId, orgId), inArray(messages.id, batch.map((root) => root.id))));
      await appendEvents(tx, ctx.orgId, rows.map((row) => ({
        kind: 'message.replied' as const, projectId: row.root.projectId, messageId: row.id, rootId: row.root.id,
      })));
      await tx.insert(auditRecords).values(rows.map((row) => ({
        id: newId(), orgId, actorKind: 'human' as const, userId, interfaceKind: 'web' as const,
        requestId: newId(), action: 'message.replied', entityType: 'message', entityId: row.id,
        after: { rootId: row.root.id },
      })));
    }, db);
    replies += rows.length;
  }
  return replies;
}

function writableProjectIds(agentIndex: number, projectIds: string[], restricted: boolean): string[] {
  if (!restricted) return projectIds;
  const width = projectIds.length <= 2 ? 1 : Math.min(20, Math.ceil(projectIds.length / 5));
  const start = (agentIndex * 3) % projectIds.length;
  const ids: string[] = [];
  for (let i = 0; i < width; i++) ids.push(projectIds[(start + i) % projectIds.length]!);
  return [...new Set(ids)];
}

async function seedOrg(orgIndex: number, envelope: Envelope): Promise<{ org: LoadOrg; roots: number; replies: number }> {
  const db = getDb();
  const ownerId = newId();
  const orgId = newId();
  const ownerName = `Load owner ${orgIndex}`;
  await db.insert(user).values({
    id: ownerId, email: `load-owner-${orgIndex}-${ownerId}@example.test`, name: ownerName, emailVerified: true,
  });
  await withOrgBootstrapTx(orgId, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: `Load org ${orgIndex}`, ownerUserId: ownerId, status: 'active' });
  }, db);
  const owner = () => principal(ownerId, orgId);
  const projects: LoadOrg['projects'] = [];
  for (let p = 0; p < envelope.projectsPerOrg; p++) {
    const slug = `o${orgIndex}p${p}`;
    const created = await createProject(owner(), { name: `Project ${orgIndex}-${p}`, slug, idempotencyKey: newId() });
    projects.push({ id: created.id, slug, rootIds: [] });
  }
  const projectIds = projects.map((project) => project.id);
  const agents: LoadAgent[] = [];
  for (let a = 0; a < envelope.agentsPerOrg; a++) {
    const restricted = a % 2 === 1;
    const writable = writableProjectIds(a, projectIds, restricted);
    const defaults = writable.slice(0, Math.min(5, writable.length));
    const name = `load-org${orgIndex}-agent${a}`;
    const issued = await setupAgentConnection(owner(), {
      agentName: name,
      clientLabel: 't15-seed',
      token: restricted
        ? { label: name, scope: 'projects', projectIds: writable, canCreateProjects: false }
        : { label: name, scope: 'org' },
      defaultProjectIds: defaults,
    });
    agents.push({
      name, agentId: issued.agent.id, secret: issued.secret, scope: restricted ? 'projects' : 'org',
      writableProjectIds: writable, listProjectId: defaults[0]!, updateRootId: '', updateVersion: 1, updateUrgent: false,
    });
  }
  await setOrgAnnouncement(owner(), {
    title: `Org ${orgIndex} announcement`,
    body: 'Pilot-envelope org announcement. Read it on every board check.',
    expectedVersion: 0,
  });
  const rootsPerOrg = Math.floor(envelope.messages / envelope.orgs / 2);
  const roots = planRoots(projectIds, agents.map((agent) => agent.agentId), rootsPerOrg, orgIndex);
  const started = Date.now();
  await insertRoots(orgId, ownerId, ownerName, roots);
  const replies = await insertReplies(orgId, ownerId, ownerName, roots, agents.map((agent) => agent.agentId));
  console.log(JSON.stringify({ phase: 'org-seeded', orgIndex, roots: roots.length, replies, seconds: Math.round((Date.now() - started) / 100) / 10 }));
  const byProject = new Map(projects.map((project) => [project.id, project]));
  for (const root of roots) byProject.get(root.projectId)?.rootIds.push(root.id);
  const used = new Set<string>();
  for (const agent of agents) {
    const allowed = new Set(agent.writableProjectIds);
    const root = roots.find((candidate) => allowed.has(candidate.projectId) && !candidate.urgent && !candidate.pinned && !used.has(candidate.id));
    if (!root) throw new Error(`no private update root for ${agent.name}`);
    used.add(root.id);
    agent.updateRootId = root.id;
  }
  return { org: { orgId, name: `Load org ${orgIndex}`, projects, agents }, roots: roots.length, replies };
}

export async function seedEnvelope(envelope: Envelope, manifestPath: string): Promise<LoadManifest> {
  const created = await createLoadDatabase(envelope.smoke ? 'amb_smoke' : 'amb_load');
  let published = false;
  try {
    process.env.DATABASE_URL = created.runtimeUrl;
    const db = getDb();
    const adminId = newId();
    await db.insert(user).values({
      id: adminId, email: `load-admin-${adminId}@example.test`, name: 'Load site admin', emailVerified: true,
    });
    await db.insert(siteAdmins).values({ userId: adminId });
    await setSiteAnnouncement({
      kind: 'human', userId: adminId, orgId: null, role: null, siteAdmin: true, interface: 'web', requestId: newId(),
    }, {
      title: 'Site announcement',
      body: 'Pilot-envelope site announcement. It is present on every board check.',
      expectedVersion: 0,
    });
    const started = Date.now();
    const seeded = await mapLimit(envelope.orgs, envelope.smoke ? 1 : 4, (orgIndex) => seedOrg(orgIndex, envelope));
    const seedSeconds = Math.round((Date.now() - started) / 100) / 10;
    const size = new pg.Client({ connectionString: ownerUrl(created) });
    await size.connect();
    let databaseBytes = 0;
    try {
      const row = await size.query<{ bytes: string }>('select pg_database_size(current_database())::bigint as bytes');
      databaseBytes = Number(row.rows[0]?.bytes ?? 0);
    } finally {
      await size.end();
    }
    const manifest: LoadManifest = {
      createdAt: new Date().toISOString(),
      commit: gitCommit(),
      smoke: envelope.smoke,
      serverVersion: created.serverVersion,
      databaseName: created.databaseName,
      roleName: created.roleName,
      adminUrl: created.adminUrl,
      runtimeUrl: created.runtimeUrl,
      seedSeconds,
      databaseBytes,
      counts: {
        orgs: seeded.length,
        projects: seeded.reduce((sum, org) => sum + org.org.projects.length, 0),
        agents: seeded.reduce((sum, org) => sum + org.org.agents.length, 0),
        roots: seeded.reduce((sum, org) => sum + org.roots, 0),
        replies: seeded.reduce((sum, org) => sum + org.replies, 0),
        messages: seeded.reduce((sum, org) => sum + org.roots + org.replies, 0),
      },
      orgs: seeded.map((org) => org.org),
    };
    const temporary = `${manifestPath}.partial`;
    writeFileSync(temporary, JSON.stringify(manifest), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, manifestPath);
    chmodSync(manifestPath, 0o600);
    published = true;
    console.log(JSON.stringify({
      phase: 'seed-done', smoke: envelope.smoke, databaseName: created.databaseName,
      seedSeconds, databaseBytes, counts: manifest.counts, serverVersion: created.serverVersion,
    }));
    return manifest;
  } finally {
    await closeDb();
    if (!published) await dropLoadDatabase(created).catch(() => undefined);
  }
}

async function mapLimit<T>(count: number, limit: number, fn: (index: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= count) return;
      results[index] = await fn(index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, count) }, () => worker()));
  return results;
}

function redact(error: unknown): string {
  const message = error instanceof Error ? error.message : 'seed failed';
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]');
}

async function main(): Promise<void> {
  const smoke = process.argv.includes('--smoke');
  const directory = scratchDir();
  const manifestPath = join(directory, smoke ? 'smoke-manifest.json' : 'manifest.json');
  await seedEnvelope(smoke ? SMOKE_ENVELOPE : FULL_ENVELOPE, manifestPath);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main().catch((error: unknown) => {
    console.error(redact(error));
    process.exit(1);
  });
}
