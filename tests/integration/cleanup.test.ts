import { Client } from 'pg';
import { expect, test } from 'vitest';
import type { TestProject } from 'vitest/node';
import setup from './setup';

test('harness cleanup drops its database and runtime role after a failing test operation', async () => {
  const provided: Record<string, string> = {};
  const project = { provide: (key: string, value: string) => { provided[key] = value; } } as TestProject;
  const teardown = await setup(project);
  try {
    await expect((async () => { throw new Error('simulated test failure'); })()).rejects.toThrow('simulated test failure');
  } finally { await teardown(); }
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  try {
    const database = await admin.query('select datname from pg_database where datname = $1', [new URL(provided.databaseUrl).pathname.slice(1)]);
    expect(database.rowCount).toBe(0);
    const role = await admin.query('select rolname from pg_roles where rolname = $1', [provided.runtimeRole]);
    expect(role.rowCount).toBe(0);
  } finally { await admin.end(); }
});
