import Link from 'next/link';
import { getProjectBySlug } from '../../../../../domain/projects';
import { ownerPrincipal, raiseDomain } from '../../../session';
import { archiveProjectAction, renameProject, restoreProjectAction } from './actions';
import { ArchiveForm, RenameForm, RestoreForm } from './forms';

export const dynamic = 'force-dynamic';

export default async function ProjectSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const principal = await ownerPrincipal();
  const { slug } = await params;
  let project: Awaited<ReturnType<typeof getProjectBySlug>>;
  try {
    project = await getProjectBySlug(principal, slug);
  } catch (error) {
    raiseDomain(error);
  }
  const archived = project.status === 'archived';
  return <div className="space-y-6">
    <p><Link href="/projects" className="underline">All projects</Link></p>
    <h1 className="text-2xl font-semibold">Settings for {project.name}</h1>
    <p>Slug {project.slug} · {archived ? 'Archived' : 'Active'}</p>
    <p>Archived projects are read-only for posting. Existing messages stay available until the project is restored.</p>
    <RenameForm key={`${project.status}-${project.name}-${project.description ?? ''}`} action={renameProject.bind(null, project.slug)} name={project.name} description={project.description ?? ''} />
    {archived ? <RestoreForm action={restoreProjectAction.bind(null, project.slug)} /> : <ArchiveForm action={archiveProjectAction.bind(null, project.slug)} />}
  </div>;
}
