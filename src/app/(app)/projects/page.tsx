import Link from 'next/link';
import { newId } from '../../../domain/kernel';
import { listProjects } from '../../../domain/projects';
import { CreateProjectForm } from './create-form';
import { ownerPrincipal, raiseDomain } from '../session';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const principal = await ownerPrincipal();
  const showArchived = (await searchParams).archived === '1';
  let projects: Awaited<ReturnType<typeof listProjects>> = [];
  try {
    projects = await listProjects(principal, { includeArchived: showArchived });
  } catch (error) {
    raiseDomain(error);
  }
  return <div className="space-y-8">
    <div className="flex flex-wrap items-baseline justify-between gap-4">
      <h1 className="text-2xl font-semibold">Projects</h1>
      <Link href={showArchived ? '/projects' : '/projects?archived=1'} className="underline">
        {showArchived ? 'Show active projects' : 'Show archived projects'}
      </Link>
    </div>
    {showArchived ? <p>Including archived projects. Archived projects are read-only for posting.</p> : null}
    {projects.length === 0 ? <p>{showArchived ? 'No projects yet.' : 'No active projects. Create one, or show archived projects.'}</p> : <ul id="project-index" className="space-y-3">{projects.map((project) => <li key={project.id} className="rounded border p-4">
      <h2 className="text-lg font-medium"><Link href={`/projects/${project.slug}`} className="underline">{project.name}</Link></h2>
      <p>Slug {project.slug} · {project.status === 'archived' ? 'Archived' : 'Active'}</p>
      {project.description ? <p>{project.description}</p> : null}
      <Link href={`/projects/${project.slug}/settings`} className="underline">Settings for {project.name}</Link>
    </li>)}</ul>}
    <section aria-labelledby="create-project-heading" className="space-y-3">
      <h2 id="create-project-heading" className="text-xl font-medium">Create a project</h2>
      <CreateProjectForm idempotencyKey={newId()} />
    </section>
  </div>;
}
