import { expect, inject, test } from 'vitest';
import { Client } from 'pg';

test('runs select 1 in a unique throwaway PostgreSQL database', async () => {
  const client = new Client({ connectionString: inject('databaseUrl') });
  await client.connect();
  try {
    const result = await client.query('select 1 as value, current_database() as database');
    expect(result.rows[0].value).toBe(1);
    expect(result.rows[0].database).toMatch(/^amb_test_[a-f0-9]{32}$/);
  } finally { await client.end(); }
});
