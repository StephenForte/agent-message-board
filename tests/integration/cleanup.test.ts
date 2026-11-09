import { Client } from 'pg';
import { expect, test } from 'vitest';
import type { TestProject } from 'vitest/node';
import setup from './setup';

test('harness cleanup drops its database after a failing test operation', async () => {
  let databaseUrl = '';
  const project = { provide: (_key: string, value: string) => { databaseUrl = value; } } as TestProject;
  const teardown = await setup(project);
  try {
    await expect((async () => { throw new Error('simulated test failure'); })()).rejects.toThrow('simulated test failure');
  } finally { await teardown(); }
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  try {
    const result = await admin.query('select datname from pg_database where datname = $1', [new URL(databaseUrl).pathname.slice(1)]);
    expect(result.rowCount).toBe(0);
  } finally { await admin.end(); }
});
