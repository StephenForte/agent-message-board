import Link from 'next/link';
import { loadHumanProject } from './load-project';

export default async function ProjectLayout({ children, params }: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { project } = await loadHumanProject(slug);
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <p><Link className="underline" href="/">Agent Message Board</Link></p>
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold break-words">{project.name}</h1>
        {project.description ? <p className="break-words">{project.description}</p> : null}
        {project.status === 'archived' ? (
          <p role="status" className="rounded border border-amber-700 bg-amber-50 p-3">This project is archived and is read-only.</p>
        ) : null}
      </header>
      {children}
    </main>
  );
}
