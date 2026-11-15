import { withOrgTx } from '../../../domain/kernel';
import { listProjects } from '../../../domain/projects';
import { loadEnv } from '../../../env';
import { connectionOwner, connectionFailure } from './guard';
import { Wizard } from './wizard';
export const dynamic = 'force-dynamic';
export default async function ConnectPage() {
  const owner = await connectionOwner();
  const allowAnnouncements = await withOrgTx(owner, async (_tx, ctx) => ctx.role === 'owner');
  let projects;
  let failure;
  try { projects = await listProjects(owner); } catch (error) { failure = connectionFailure(error); }
  if (failure || !projects) return <p role="alert">{failure?.message}</p>;
    return <main className="space-y-6"><h1 className="text-2xl font-semibold">Connect an agent</h1><Wizard allowAnnouncements={allowAnnouncements} projects={projects.map(({ id, name }) => ({ id, name }))} mcpUrl={`${loadEnv().APP_BASE_URL.replace(/\/$/, '')}/api/mcp`} /></main>;
}
