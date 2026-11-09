import { randomBytes } from 'node:crypto';
import * as schema from '../../../src/db/schema';
import { newId, type HumanPrincipal } from '../../../src/domain/kernel';
import { adminUrl, openDatabase, runtimeUrl } from '../helpers';

export { schema };
export const admin = openDatabase(adminUrl());
export const runtime = openDatabase(runtimeUrl(), 8);
export async function seed() {
  const userId = newId(), orgId = newId(), projectId = newId(), tokenId = newId(), agentId = newId(), sessionId = newId();
  await admin.db.insert(schema.user).values({ id: userId, name: 'Real Owner', email: `${userId}@example.com`, emailVerified: true });
  await admin.db.insert(schema.organizations).values({ id: orgId, name: 'Messages test', ownerUserId: userId, status: 'active' });
  await admin.db.insert(schema.projects).values({ id: projectId, orgId, slug: 'board', name: 'Board', status: 'active', createdByKind: 'human', createdByUserId: userId });
  await admin.db.insert(schema.agentTokens).values({ id: tokenId, orgId, label: 'test', prefix: randomBytes(4).toString('hex'), tokenHash: randomBytes(32).toString('hex'), scope: 'projects', createdByUserId: userId });
  await admin.db.insert(schema.agents).values({ id: agentId, orgId, name: 'agent' });
  await admin.db.insert(schema.agentSessions).values({ id: sessionId, orgId, agentId, tokenId });
  await admin.db.insert(schema.tokenProjectGrants).values({ orgId, tokenId, projectId, source: 'owner' });
  const human: HumanPrincipal = { kind: 'human', userId, orgId, siteAdmin: false, interface: 'web', requestId: newId() };
  const agent = { kind: 'agent' as const, orgId, tokenId, scope: 'projects' as const, projectIds: [projectId], canCreateProjects: false, agentId, sessionId, interface: 'mcp' as const, requestId: newId() };
  return { userId, orgId, projectId, tokenId, agentId, sessionId, human, agent };
}
export async function hiddenProject(s: Awaited<ReturnType<typeof seed>>) {
  const id = newId();
  await admin.db.insert(schema.projects).values({ id, orgId: s.orgId, slug: `hidden-${id}`, name: 'Hidden', status: 'active', createdByKind: 'human', createdByUserId: s.userId });
  return id;
}
