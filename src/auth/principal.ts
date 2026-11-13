import { eq } from 'drizzle-orm';
import { getDb, type AppDatabase } from '../db/client';
import { orgMembers, organizations } from '../db/schema/org';
import { user } from '../db/schema/auth';
import { siteAdmins } from '../db/schema/site-admins';
import type { HumanPrincipal } from '../domain/kernel';
import { requestId } from '../lib/log';
import { getAuth, type Auth } from './index';

export async function getHumanPrincipal(
  headers: Headers,
  auth: Auth = getAuth(),
  database: AppDatabase = getDb(),
): Promise<HumanPrincipal | null> {
  const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
  if (!session || session.session.expiresAt <= new Date()) return null;
  // Read verification fresh as well as session validity; no stale cookie claims.
  const [fresh] = await database.select().from(user).where(eq(user.id, session.user.id));
  if (!fresh?.emailVerified) return null;
  const [owned] = await database.select({ id: organizations.id }).from(organizations)
    .where(eq(organizations.ownerUserId, fresh.id)).limit(1);
  const [membership] = owned ? [] : await database.select({ orgId: orgMembers.orgId }).from(orgMembers)
    .where(eq(orgMembers.userId, fresh.id)).limit(1);
  const orgId = owned?.id ?? membership?.orgId ?? null;
  const role = owned ? 'owner' as const : membership ? 'member' as const : null;
  const [admin] = await database.select().from(siteAdmins).where(eq(siteAdmins.userId, fresh.id));
  return { kind: 'human', userId: fresh.id, orgId, role, siteAdmin: !!admin,
    requestId: requestId(headers.get('x-request-id')), interface: 'web' };
}
