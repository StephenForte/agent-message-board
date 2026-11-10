import { randomBytes, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { assertSafeIdent, sleep } from './scratch';

export type CreatedDatabase = {
  databaseName: string;
  roleName: string;
  adminUrl: string;
  runtimeUrl: string;
  serverVersion: string;
};

function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required (CREATE DATABASE)');
  return url;
}

/** Private database plus a non-superuser, non-bypassrls role so the run is subject to FORCE RLS. */
export async function createLoadDatabase(prefix: string): Promise<CreatedDatabase> {
  const databaseName = assertSafeIdent(`${prefix}_${randomUUID().replaceAll('-', '')}`, 'database');
  const roleName = assertSafeIdent(`${prefix}_rt_${randomBytes(6).toString('hex')}`, 'role');
  const password = randomBytes(18).toString('hex');
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  let databaseCreated = false;
  let roleCreated = false;
  try {
    const version = await admin.query<{ server_version: string }>('show server_version');
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    const ownerUrl = new URL(adminUrl());
    ownerUrl.pathname = `/${databaseName}`;
    const pool = new pg.Pool({ connectionString: ownerUrl.toString(), max: 1 });
    try {
      await migrate(drizzle(pool), { migrationsFolder: 'drizzle' });
    } finally {
      await pool.end();
    }
    await admin.query(
      `CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roleCreated = true;
    await admin.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO "${roleName}"`);
    const grant = new pg.Client({ connectionString: ownerUrl.toString() });
    await grant.connect();
    try {
      await grant.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
      await grant.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${roleName}"`);
      await grant.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${roleName}"`);
    } finally {
      await grant.end();
    }
    const runtime = new URL(ownerUrl.toString());
    runtime.username = roleName;
    runtime.password = password;
    return {
      databaseName,
      roleName,
      adminUrl: adminUrl(),
      runtimeUrl: runtime.toString(),
      serverVersion: version.rows[0]?.server_version ?? 'unknown',
    };
  } catch (error) {
    if (databaseCreated) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => undefined);
    }
    if (roleCreated) await admin.query(`DROP ROLE IF EXISTS "${roleName}"`).catch(() => undefined);
    throw error;
  } finally {
    await admin.end();
  }
}

export function ownerUrl(database: { adminUrl: string; databaseName: string }): string {
  const url = new URL(database.adminUrl);
  url.pathname = `/${assertSafeIdent(database.databaseName, 'database')}`;
  return url.toString();
}

/**
 * End every pool before calling this. Wait until no backends remain, then DROP
 * without FORCE (board hazard 379035a1: FORCE after pool.end emits 57P01).
 */
export async function dropLoadDatabase(database: { adminUrl: string; databaseName: string; roleName: string }): Promise<void> {
  const databaseName = assertSafeIdent(database.databaseName, 'database');
  const roleName = assertSafeIdent(database.roleName, 'role');
  const admin = new pg.Client({ connectionString: database.adminUrl });
  await admin.connect();
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const activity = await admin.query<{ n: number }>(
        'select count(*)::int as n from pg_stat_activity where datname = $1',
        [databaseName],
      );
      const backends = activity.rows[0]?.n ?? 0;
      if (backends === 0) break;
      if (Date.now() > deadline) {
        throw new Error(`refusing to drop ${databaseName}: ${backends} backends still connected`);
      }
      await sleep(200);
    }
    const exists = await admin.query<{ n: number }>('select count(*)::int as n from pg_database where datname = $1', [databaseName]);
    if ((exists.rows[0]?.n ?? 0) > 0) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.query(`DROP ROLE IF EXISTS "${roleName}"`);
  } finally {
    await admin.end();
  }
}

export type GrowthSnapshot = {
  at: string;
  databaseBytes: number;
  relations: Record<string, number>;
  counts: {
    auditRecords: number;
    sessionSeen: number;
    rateLimitWindows: number;
    events: number;
    idempotencyRecords: number;
    messages: number;
  };
};

const RELATIONS = ['audit_records', 'rate_limit_windows', 'events', 'idempotency_records', 'messages'] as const;

export async function growthSnapshot(database: { adminUrl: string; databaseName: string }): Promise<GrowthSnapshot> {
  const client = new pg.Client({ connectionString: ownerUrl(database) });
  await client.connect();
  try {
    const size = await client.query<{ bytes: string }>('select pg_database_size(current_database())::bigint as bytes');
    const relations = await client.query<{ relname: string; bytes: string }>(
      `select relname, pg_total_relation_size(oid)::bigint as bytes
       from pg_class where relkind = 'r' and relname = any($1::text[])`,
      [[...RELATIONS]],
    );
    const counts = await client.query<{
      audit_records: number; session_seen: number; rate_limit_windows: number;
      events: number; idempotency_records: number; messages: number;
    }>(`select
      (select count(*)::int from audit_records) as audit_records,
      (select count(*)::int from audit_records where action = 'agent.session_seen') as session_seen,
      (select count(*)::int from rate_limit_windows) as rate_limit_windows,
      (select count(*)::int from events) as events,
      (select count(*)::int from idempotency_records) as idempotency_records,
      (select count(*)::int from messages) as messages`);
    const row = counts.rows[0];
    const relationBytes: Record<string, number> = {};
    for (const name of RELATIONS) relationBytes[name] = 0;
    for (const relation of relations.rows) relationBytes[relation.relname] = Number(relation.bytes);
    return {
      at: new Date().toISOString(),
      databaseBytes: Number(size.rows[0]?.bytes ?? 0),
      relations: relationBytes,
      counts: {
        auditRecords: row?.audit_records ?? 0,
        sessionSeen: row?.session_seen ?? 0,
        rateLimitWindows: row?.rate_limit_windows ?? 0,
        events: row?.events ?? 0,
        idempotencyRecords: row?.idempotency_records ?? 0,
        messages: row?.messages ?? 0,
      },
    };
  } finally {
    await client.end();
  }
}
