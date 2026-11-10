import { randomBytes, randomUUID } from 'node:crypto';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { openDatabase } from '../helpers';

const quietDeadlineMs = 5_000;

export async function createShellDatabase(): Promise<{
  admin: ReturnType<typeof openDatabase>;
  runtime: ReturnType<typeof openDatabase>;
  cleanup: () => Promise<void>;
}> {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error('TEST_DATABASE_URL is required');
  const name = `amb_t08_${randomUUID().replaceAll('-', '')}`;
  const role = `amb_t08_${randomBytes(8).toString('hex')}`;
  const password = randomBytes(18).toString('hex');
  const adminClient = new pg.Client({ connectionString: base });
  let created = false;
  let roleCreated = false;
  let admin: ReturnType<typeof openDatabase> | undefined;
  let runtime: ReturnType<typeof openDatabase> | undefined;
  const cleanup = async () => {
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
    await adminClient.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
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
    runtime = openDatabase(runtimeUrl.toString(), 4);
    return { admin, runtime, cleanup };
  } catch (error) {
    await cleanup();
    const reason = error instanceof Error ? error.message : 'unknown error';
    throw new Error(reason.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]'));
  }
}

async function dropDatabaseWhenQuiet(client: pg.Client, databaseName: string): Promise<void> {
  const deadline = Date.now() + quietDeadlineMs;
  for (;;) {
    const activity = await client.query<{ n: number }>('select count(*)::int as n from pg_stat_activity where datname = $1', [databaseName]);
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

export function countClientQueries(pool: pg.Pool): { count: number } {
  const box = { count: 0 };
  pool.on('connect', (client) => {
    const query = client.query.bind(client);
    client.query = ((...args: unknown[]) => {
      box.count += 1;
      return query(...(args as Parameters<pg.PoolClient['query']>));
    }) as typeof client.query;
  });
  return box;
}
