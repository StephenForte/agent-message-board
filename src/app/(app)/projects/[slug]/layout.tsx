import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import { loadFailureMessage } from './domain-message';
import { loadHumanProject } from './load-project';
import { RetryPanel } from './retry-panel';

async function loadBoard(slug: string) {
  try {
    const { project } = await loadHumanProject(slug);
    return { ok: true as const, project };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false as const, message: loadFailureMessage(error, 'board') };
  }
}

export default async function ProjectLayout({ children, params }: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const loaded = await loadBoard(slug);
  if (!loaded.ok) {
    return (
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
        <p><Link className="underline" href="/">Agent Message Board</Link></p>
        <RetryPanel message={loaded.message} />
      </main>
    );
  }
  const { project } = loaded;
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
