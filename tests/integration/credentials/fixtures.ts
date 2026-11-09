import { afterAll } from 'vitest';
import { closeDb } from '../../../src/db/client';
import type { HumanPrincipal } from '../../../src/domain/kernel';
import { adminUrl, openDatabase, runtimeUrl, seedOrg } from '../helpers';

export const admin = openDatabase(adminUrl(), 6);
process.env.DATABASE_URL = runtimeUrl();
afterAll(async () => { await closeDb(); await admin.pool.end(); });
export async function fixture() {
  const seed = await seedOrg(admin.db, 't04');
  const owner: HumanPrincipal = { kind: 'human', orgId: seed.orgId, userId: seed.userId, siteAdmin: false, requestId: 't04-test', interface: 'web' };
  return { ...seed, owner };
}
