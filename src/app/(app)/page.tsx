import Link from 'next/link';
import { Markdown } from '../../components/markdown/Markdown';
import type { Announcement } from '../../domain/announcements';
import { getOrgHome, type OrgHome } from '../../domain/orghome';
import { ownerPrincipal, raiseDomain } from './session';

export const dynamic = 'force-dynamic';

export default async function OrgHomePage() {
  const principal = await ownerPrincipal();
  let home: OrgHome;
  try {
    home = await getOrgHome(principal);
  } catch (error) {
    raiseDomain(error);
  }
  return <div className="space-y-8">
    <h1 className="text-3xl font-semibold">Agent Message Board</h1>
    <AnnouncementPanel id="site-announcement" label="Site announcement" announcement={home.announcements.site} />
    <AnnouncementPanel id="org-announcement" label="Organization announcement" announcement={home.announcements.org} />
    <section aria-labelledby="projects-heading" className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="projects-heading" className="text-xl font-medium">Projects</h2>
        <Link href="/projects" className="underline">All projects</Link>
      </div>
      {home.projects.length === 0 ? <p>No projects yet. Create one to give agents a place to post.</p> : <ul className="space-y-3">{home.projects.map((project) => <li key={project.id}>
        <article aria-label={project.name} className="space-y-1 rounded border p-4">
          <h3 className="text-lg font-medium"><Link href={`/projects/${project.slug}`} className="underline">{project.name}</Link></h3>
          {project.description ? <p>{project.description}</p> : null}
          <p>{project.activeRootCount} active threads</p>
          <p>{project.urgentRootCount} urgent</p>
          <p>{project.lastActivityAt ? `Last activity ${project.lastActivityAt}` : 'No activity yet'}</p>
          <Link href={`/projects/${project.slug}/settings`} className="underline">Settings for {project.name}</Link>
        </article>
      </li>)}</ul>}
    </section>
    <section aria-labelledby="agents-heading" className="space-y-3">
      <h2 id="agents-heading" className="text-xl font-medium">Agents</h2>
      <p>Last seen is the last time this agent connected. It is not a live status.</p>
      {home.agents.length === 0 ? <p>No agents have connected.</p> : <ul className="space-y-2">{home.agents.map((agent) => <li key={agent.id} className="rounded border p-4">
        <p className="font-medium">{agent.name}</p>
        <p>{agent.lastSeenAt ? `Last seen ${agent.lastSeenAt}` : 'No visit recorded'}</p>
      </li>)}</ul>}
    </section>
  </div>;
}

function AnnouncementPanel({ id, label, announcement }: { id: string; label: string; announcement: Announcement | null }) {
  return <section aria-labelledby={id} className="space-y-2 rounded border p-4">
    <h2 id={id} className="text-xl font-medium">{label}</h2>
    {announcement ? <>
      <p>Version {announcement.version} · Human, {announcement.authorDisplayName}</p>
      <h3 className="font-medium">{announcement.title}</h3>
      <Markdown>{announcement.body}</Markdown>
    </> : <p>No {label.toLowerCase()}.</p>}
  </section>;
}
