import { randomBytes, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    runtimeDatabaseUrl: string;
    runtimeRole: string;
  }
}

export default async function setup(project: TestProject) {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error('TEST_DATABASE_URL is required; integration tests must use real PostgreSQL (CREATE DATABASE permission required).');
  const name = `amb_test_${randomUUID().replaceAll('-', '')}`;
  const role = `amb_rt_${randomUUID().replaceAll('-', '')}`;
  const password = randomBytes(18).toString('hex');
  const admin = new pg.Client({ connectionString: base });
  let created = false;
  let roleCreated = false;
  const cleanup = async () => {
    try {
      if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally {
      try {
        if (roleCreated) await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      } finally {
        await admin.end();
      }
    }
  };
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(base);
    url.pathname = `/${name}`;
    const databaseUrl = url.toString();
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await migrate(drizzle(pool), { migrationsFolder: 'drizzle' });
    } finally {
      await pool.end();
    }
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    roleCreated = true;
    await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO "${role}"`);
    const grant = new pg.Client({ connectionString: databaseUrl });
    await grant.connect();
    try {
      await grant.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await grant.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
      await grant.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
    } finally {
      await grant.end();
    }
    const runtime = new URL(databaseUrl);
    runtime.username = role;
    runtime.password = password;
    project.provide('runtimeDatabaseUrl', runtime.toString());
    project.provide('runtimeRole', role);
    project.provide('databaseUrl', databaseUrl);
    return cleanup;
  } catch (error) {
    await cleanup();
    const reason = error instanceof Error ? error.message : 'unknown error';
    const redacted = reason.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted-url]');
    throw new Error(`PostgreSQL integration setup failed; check TEST_DATABASE_URL connectivity and CREATE DATABASE permission. ${redacted}`);
  }
}
