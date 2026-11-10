import { hashPassword } from 'better-auth/crypto';
import type { Page } from '@playwright/test';
import { createDatabase, closeDb, type AppDatabase } from '../../../src/db/client';
import { account, user } from '../../../src/db/schema/auth';
import { agents } from '../../../src/db/schema/identity';
import { messages } from '../../../src/db/schema/messages';
import { organizations } from '../../../src/db/schema/org';
import { announcements } from '../../../src/db/schema/announcements';
import { auditRecords } from '../../../src/db/schema/ops';
import { projects } from '../../../src/db/schema/projects';
import { siteAdmins } from '../../../src/db/schema/site-admins';
import { listAnnouncementRevisions, setSiteAnnouncement } from '../../../src/domain/announcements';
import { newId, withOrgBootstrapTx } from '../../../src/domain/kernel';

export const password = 'synthetic-e2e-password';

export async function withE2e<T>(run: (db: AppDatabase) => Promise<T>): Promise<T> {
  const runtime = createDatabase(process.env.AMB_E2E_DATABASE_URL!);
  try {
    return await run(runtime.db);
  } finally {
    await runtime.pool.end();
  }
}

export async function seedPerson(options: { name: string; admin?: boolean; orgStatus?: 'active' | 'suspended' }) {
  return withE2e(async (db) => {
    const id = newId();
    const email = `${id}@example.com`;
    const orgId = newId();
    await db.insert(user).values({ id, email, name: options.name, emailVerified: true });
    await db.insert(account).values({
      id: newId(), userId: id, accountId: id, providerId: 'credential', password: await hashPassword(password),
    });
    if (options.admin) await db.insert(siteAdmins).values({ userId: id });
    if (options.orgStatus) {
      await withOrgBootstrapTx(orgId, async (tx) => {
        await tx.insert(organizations).values({ id: orgId, name: `${options.name} org`, ownerUserId: id, status: options.orgStatus! });
      }, db);
    }
    return { id, email, orgId: options.orgStatus ? orgId : null, name: options.name };
  });
}

export async function signIn(page: Page, email: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
}

export async function publishSiteAnnouncement(authorUserId: string, title: string, body: string) {
  process.env.DATABASE_URL = process.env.AMB_E2E_DATABASE_URL;
  const principal = {
    kind: 'human' as const, userId: authorUserId, orgId: null, siteAdmin: true,
    interface: 'web' as const, requestId: `e2e-site-${authorUserId}`,
  };
  try {
    const history = await listAnnouncementRevisions(principal, { scope: 'site', limit: 1 });
    await setSiteAnnouncement(principal, { title, body, expectedVersion: history[0]?.version ?? 0 });
  } finally {
    await closeDb();
  }
}

export async function insertOrgAnnouncement(orgId: string, authorUserId: string, title: string, body: string) {
  await withE2e(async (db) => {
    await db.insert(announcements).values({
      id: newId(), scope: 'org', orgId, title, body, version: 1, authorUserId,
    });
  });
}

export async function insertProject(orgId: string, userId: string, name: string, slug: string, status: 'active' | 'archived' = 'active') {
  return withE2e(async (db) => {
    const id = newId();
    await db.insert(projects).values({
      id, orgId, slug, name, status, createdByKind: 'human', createdByUserId: userId,
    });
    return id;
  });
}

export async function insertRoot(input: {
  orgId: string; projectId: string; userId: string; author: string; title: string;
  urgent?: boolean; status?: 'active' | 'archived'; lastActivityAt?: Date;
}) {
  await withE2e(async (db) => {
    await db.insert(messages).values({
      id: newId(), orgId: input.orgId, projectId: input.projectId, title: input.title, body: input.title,
      category: 'note', status: input.status ?? 'active', urgent: input.urgent ?? false, pinned: false, version: 1,
      lastActivityAt: input.lastActivityAt ?? new Date('2026-11-02T00:00:00.000Z'),
      authorKind: 'human', authorUserId: input.userId, authorDisplayName: input.author,
    });
  });
}

export async function insertAgent(orgId: string, name: string, lastSeenAt: Date) {
  await withE2e(async (db) => {
    await db.insert(agents).values({ id: newId(), orgId, name, lastSeenAt });
  });
}

export async function insertAudit(orgId: string, userId: string, action: string, after: Record<string, unknown>) {
  await withE2e(async (db) => {
    await db.insert(auditRecords).values({
      id: newId(), orgId, actorKind: 'human', userId, interfaceKind: 'web', requestId: 'e2e-shell',
      action, entityType: 'project', entityId: newId(), after,
    });
  });
}
