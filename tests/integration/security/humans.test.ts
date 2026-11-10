import { afterAll, expect, test } from 'vitest';
import { closeDb } from '../../../src/db/client';
import { user } from '../../../src/db/schema/auth';
import { siteAdmins } from '../../../src/db/schema/site-admins';
import * as c from '../../../src/domain/credentials';
import { checkBoard } from '../../../src/domain/briefing';
import { getAnnouncements, listAnnouncementRevisions } from '../../../src/domain/announcements';
import { getOrgHome, getOwnerProfile } from '../../../src/domain/orghome';
import { listAuditLog } from '../../../src/domain/auditlog';
import { getThread, getThreadHistory, listThreads } from '../../../src/domain/messages';
import { getProjectBySlug, listProjects } from '../../../src/domain/projects';
import { newId, type HumanPrincipal } from '../../../src/domain/kernel';
import { adminUrl, insertRoot, openDatabase, runtimeUrl, seedOrg } from '../helpers';
const admin = openDatabase(adminUrl());
process.env.DATABASE_URL = runtimeUrl();
afterAll(async () => { await closeDb(); await admin.pool.end(); });

test('site admin without ownership and verified user without org cannot read any tenant domain surface', async () => {
  const target = await seedOrg(admin.db, 'target');
  const root = await insertRoot(admin.db, target, 'real-private-root');
  for (const siteAdmin of [true, false]) {
    const outsiderId = newId();
    await admin.db.insert(user).values({ id: outsiderId, name: 'No organization', email: `${outsiderId}@example.com`, emailVerified: true });
    if (siteAdmin) await admin.db.insert(siteAdmins).values({ userId: outsiderId });
    // Also try a forged org id: a valid admin claim must never replace ownership.
    for (const orgId of [null, target.orgId]) {
      const p: HumanPrincipal = { kind: 'human', userId: outsiderId, orgId, siteAdmin, interface: 'web', requestId: newId() };
      const reads: Array<() => Promise<unknown>> = [
        () => listProjects(p), () => getProjectBySlug(p, 'alpha'),
        () => listThreads(p, { projectIds: [target.projectId] }), () => getThread(p, { rootId: root }),
        () => getThreadHistory(p, root), () => checkBoard(p, { projectId: target.projectId }),
        () => c.listTokens(p), () => c.listAgents(p), () => c.listAgentSessions(p, target.agentId),
        () => c.getAgentDefaults(p, target.agentId), () => getOrgHome(p), () => getOwnerProfile(p),
        () => listAuditLog(p), () => getAnnouncements(p), () => listAnnouncementRevisions(p, { scope: 'org' }),
      ];
      for (const read of reads) await expect(read()).rejects.toMatchObject({ code: 'forbidden_or_not_found' });
    }
  }
});
