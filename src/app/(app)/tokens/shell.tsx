export function PageShell({ title, children }: { title: string; children: React.ReactNode }) {
  return <main className="mx-auto max-w-3xl space-y-8 p-8">
    <h1 className="text-3xl font-semibold">{title}</h1>
    {children}
  </main>;
}
