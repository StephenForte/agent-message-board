import { afterAll, expect, test } from 'vitest';
import { closeDb } from '../../src/db/client';
import { GET } from '../../src/app/api/health/route';
import { runtimeUrl } from './helpers';

const previous = process.env.DATABASE_URL;

afterAll(async () => {
  if (previous === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previous;
  await closeDb();
});

test('health returns 503 without the URL when the database is unreachable, and 200 when it is up', async () => {
  process.env.DATABASE_URL = 'postgresql://amb_invalid:amb_invalid@127.0.0.1:59999/amb_unreachable';
  await closeDb();
  const down = await GET();
  const body = await down.json() as { status: string };
  expect(down.status).toBe(503);
  expect(body).toEqual({ status: 'unavailable' });
  expect(JSON.stringify(body)).not.toContain('amb_invalid');

  process.env.DATABASE_URL = runtimeUrl();
  await closeDb();
  const up = await GET();
  expect(up.status).toBe(200);
  expect(await up.json()).toEqual({ status: 'ok' });
});
