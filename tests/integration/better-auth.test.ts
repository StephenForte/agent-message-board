import { eq } from 'drizzle-orm';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { afterAll, expect, test } from 'vitest';
import { betterAuthDrizzleConfig, user } from '../../src/db/auth-schema';
import { newId } from '../../src/domain/kernel/ids';
import { openDatabase, runtimeUrl } from './helpers';

const runtime = openDatabase(runtimeUrl());

afterAll(async () => {
  await runtime.pool.end();
});

test('property 9: better-auth signs up against the exported Drizzle schema', async () => {
  const auth = betterAuth({
    database: drizzleAdapter(runtime.db, betterAuthDrizzleConfig),
    emailAndPassword: { enabled: true },
    secret: 't02-better-auth-secret-t02-better-auth',
    baseURL: 'http://localhost:3000',
    rateLimit: { enabled: false },
  });
  const email = `t02-${newId()}@example.com`;
  const created = await auth.api.signUpEmail({
    body: { email, password: 'correct-horse-battery', name: 'T02 User' },
  });
  expect(created.user.email).toBe(email);
  const rows = await runtime.db.select().from(user).where(eq(user.email, email));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.name).toBe('T02 User');
  expect(rows[0]?.emailVerified).toBe(false);
});
