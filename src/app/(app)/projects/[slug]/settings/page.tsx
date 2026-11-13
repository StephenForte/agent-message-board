import Link from 'next/link';
import { getProjectBySlug } from '../../../../../domain/projects';
import { raiseDomain, requireOrgOwnerPage } from '../../../session';
import { archiveProjectAction, renameProject, restoreProjectAction, setVisibility } from './actions';
import { ArchiveForm, RenameForm, RestoreForm, VisibilityForm } from './forms';

export const dynamic = 'force-dynamic';

export default async function ProjectSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const principal = await requireOrgOwnerPage();
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
    <VisibilityForm key={project.visibility} action={setVisibility.bind(null, project.slug)} visibility={project.visibility === 'public' ? 'public' : 'private'} />
    {archived ? <RestoreForm action={restoreProjectAction.bind(null, project.slug)} /> : <ArchiveForm action={archiveProjectAction.bind(null, project.slug)} />}
  </div>;
}
