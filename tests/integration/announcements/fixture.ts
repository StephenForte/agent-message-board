import { randomBytes, randomUUID } from 'node:crypto';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from '../../../src/db/schema/index';
import { newId } from '../../../src/domain/kernel/ids';
import { openDatabase, sha256Hex, tokenPrefix, type TestDatabase } from '../helpers';

export type OrgSeed = {
  userId: string;
  userName: string;
  orgId: string;
  visibleProjectId: string;
  hiddenProjectId: string;
  orgTokenId: string;
  restrictedTokenId: string;
};

/**
 * Own database so site-announcement tests do not collide with the shared
 * suite's single site row in rls.test.ts. Dropped in cleanup.
 */
export async function createAnnouncementDatabase(): Promise<{
  admin: ReturnType<typeof openDatabase>;
  runtime: ReturnType<typeof openDatabase>;
  cleanup: () => Promise<void>;
}> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error('TEST_DATABASE_URL is required');
  const name = `amb_t06_${randomUUID().replaceAll('-', '')}`;
  const role = `amb_t06_${randomBytes(8).toString('hex')}`;
  const password = randomBytes(18).toString('hex');
  const adminClient = new pg.Client({ connectionString: base });
  let created = false;
  let roleCreated = false;
  let admin: ReturnType<typeof openDatabase> | undefined;
  let runtime: ReturnType<typeof openDatabase> | undefined;
  const cleanup = async () => {
    // pg-pool resolves end() before idle backends leave pg_stat_activity.
    // DROP DATABASE ... WITH (FORCE) then kills those sockets, and the pool
    // emits 57P01 with no listener. Wait until none remain, and do not FORCE.
    await admin?.pool.end().catch(() => undefined);
    await runtime?.pool.end().catch(() => undefined);
    try {
      if (created) await dropDatabaseWhenQuiet(adminClient, name);
    } finally {
      try {
        if (roleCreated) await adminClient.query(`DROP ROLE IF EXISTS "${role}"`);
      } finally {
        await adminClient.end().catch(() => undefined);
      }
    }
  };
  try {
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(base);
    url.pathname = `/${name}`;
    const databaseUrl = url.toString();
    const migrating = openDatabase(databaseUrl, 1);
    try {
      await migrate(migrating.db, { migrationsFolder: 'drizzle' });
    } finally {
      await migrating.pool.end();
    }
    await adminClient.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roleCreated = true;
    await adminClient.query(`GRANT CONNECT ON DATABASE "${name}" TO "${role}"`);
    const grant = new pg.Client({ connectionString: databaseUrl });
    await grant.connect();
    try {
      await grant.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await grant.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
      await grant.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
    } finally {
      await grant.end();
    }
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    admin = openDatabase(databaseUrl, 4);
    runtime = openDatabase(runtimeUrl.toString(), 8);
    return { admin, runtime, cleanup };
  } catch (error) {
    await cleanup();
    const reason = error instanceof Error ? error.message : 'unknown error';
    throw new Error(reason.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]'));
  }
}

const quietDeadlineMs = 5_000;

async function dropDatabaseWhenQuiet(client: pg.Client, databaseName: string): Promise<void> {
  const deadline = Date.now() + quietDeadlineMs;
  for (;;) {
    const activity = await client.query<{ n: number }>(
      'select count(*)::int as n from pg_stat_activity where datname = $1',
      [databaseName],
    );
    const backends = activity.rows[0]?.n ?? 0;
    if (backends === 0) {
      try {
        await client.query(`DROP DATABASE "${databaseName}"`);
        return;
      } catch (error) {
        if (!isObjectInUse(error) || Date.now() >= deadline) throw error;
      }
    } else if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${backends} connection(s) to close before dropping ${databaseName}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function isObjectInUse(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '55006';
}

export async function seedOrg(db: TestDatabase, label: string): Promise<OrgSeed> {
  const userId = newId();
  const orgId = newId();
  const visibleProjectId = newId();
  const hiddenProjectId = newId();
  const orgTokenId = newId();
  const restrictedTokenId = newId();
  const userName = `${label} owner`;
  await db.insert(schema.user).values({
    id: userId,
    name: userName,
    email: `${label}-${userId}@example.com`,
    emailVerified: true,
  });
  await db.insert(schema.organizations).values({
    id: orgId,
    name: label,
    ownerUserId: userId,
    status: 'active',
  });
  await db.insert(schema.projects).values([
    {
      id: visibleProjectId, orgId, slug: 'visible', name: 'Visible', status: 'active',
      createdByKind: 'human', createdByUserId: userId,
    },
    {
      id: hiddenProjectId, orgId, slug: 'hidden', name: 'Hidden', status: 'active',
      createdByKind: 'human', createdByUserId: userId,
    },
  ]);
  await db.insert(schema.agentTokens).values([
    {
      id: orgTokenId, orgId, label: 'org-wide', prefix: tokenPrefix(), tokenHash: sha256Hex(),
      scope: 'org', canCreateProjects: false, createdByUserId: userId,
    },
    {
      id: restrictedTokenId, orgId, label: 'restricted', prefix: tokenPrefix(), tokenHash: sha256Hex(),
      scope: 'projects', canCreateProjects: false, createdByUserId: userId,
    },
  ]);
  await db.insert(schema.tokenProjectGrants).values({
    orgId, tokenId: restrictedTokenId, projectId: visibleProjectId, source: 'owner',
  });
  return { userId, userName, orgId, visibleProjectId, hiddenProjectId, orgTokenId, restrictedTokenId };
}

export async function seedSiteAdmin(db: TestDatabase, name: string): Promise<{ userId: string; userName: string }> {
  const userId = newId();
  await db.insert(schema.user).values({
    id: userId,
    name,
    email: `admin-${userId}@example.com`,
    emailVerified: true,
  });
  await db.insert(schema.siteAdmins).values({ userId });
  return { userId, userName: name };
}
