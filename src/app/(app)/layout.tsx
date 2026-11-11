import { AppShell } from '../../components/board/app-shell';
import { getOwnerProfile } from '../../domain/orghome';
import { listProjects } from '../../domain/projects';
import { ownerPrincipal, raiseDomain } from './session';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const principal = await ownerPrincipal();
  let name = 'Owner';
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
  return <AppShell name={name} siteAdmin={principal.siteAdmin} projects={projects.filter((project) => project.status === 'active').map((project) => ({ slug: project.slug, name: project.name }))}>
    {children}
  </AppShell>;
}
