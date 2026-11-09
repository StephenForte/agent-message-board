import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' { export interface ProvidedContext { databaseUrl: string } }

export default async function setup(project: TestProject) {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error('TEST_DATABASE_URL is required; integration tests must use real PostgreSQL (CREATE DATABASE permission required).');
  const name = `amb_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: base });
  let created = false;
  const cleanup = async () => {
    try { if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
    finally { await admin.end(); }
  };
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(base);
    url.pathname = `/${name}`;
    project.provide('databaseUrl', url.toString());
    return cleanup;
  } catch {
    await cleanup();
    throw new Error('PostgreSQL integration setup failed; check TEST_DATABASE_URL connectivity and CREATE DATABASE permission.');
  }
}
