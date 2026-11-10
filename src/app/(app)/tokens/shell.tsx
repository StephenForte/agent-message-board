import Link from 'next/link';

export function PageShell({ title, children }: { title: string; children: React.ReactNode }) {
  return <main className="mx-auto max-w-3xl space-y-8 p-8">
    <nav aria-label="Sections" className="flex gap-4 text-sm">
      <Link className="underline" href="/tokens">Tokens</Link>
      <Link className="underline" href="/agents">Agents</Link>
    </nav>
    <h1 className="text-3xl font-semibold">{title}</h1>
    {children}
  </main>;
}
