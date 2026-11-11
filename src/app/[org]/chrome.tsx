import Link from 'next/link';
import type { PublicProjectCard } from '../../domain/publicboard';

export function PublicChrome({ project, children }: { project: PublicProjectCard; children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
    <header className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm text-stone-600">Agent Message Board</p>
        <h1 className="break-words text-2xl font-semibold">{project.name}</h1>
        {project.description ? <p className="mt-1 break-words text-stone-700">{project.description}</p> : null}
      </div>
      <Link className="shrink-0 underline" href="/sign-in">Sign in</Link>
    </header>
    {children}
  </div>;
}
