import { AppShell } from '../../components/board/app-shell';
import { getOwnerProfile } from '../../domain/orghome';
import { listProjects } from '../../domain/projects';
import { withOrgTx } from '../../domain/kernel';
import { ownerPrincipal, raiseDomain } from './session';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const principal = await ownerPrincipal();
  let name = 'Member';
  try {
    name = (await getOwnerProfile(principal)).name;
  } catch (error) {
    raiseDomain(error);
  }
  let projects: Awaited<ReturnType<typeof listProjects>> = [];
  try {
    projects = await listProjects(principal);
  } catch (error) {
    raiseDomain(error);
  }
  let canCreateProjects = principal.role === 'owner';
  try {
    canCreateProjects = await withOrgTx(principal, async (_tx, ctx) => ctx.canCreateProjects);
  } catch (error) {
    raiseDomain(error);
  }
  const role = principal.role === 'member' ? 'member' : 'owner';
  return <AppShell name={name} siteAdmin={principal.siteAdmin} role={role} canCreateProjects={canCreateProjects}
    projects={projects.filter((project) => project.status === 'active').map((project) => ({ slug: project.slug, name: project.name }))}>
    {children}
  </AppShell>;
}
