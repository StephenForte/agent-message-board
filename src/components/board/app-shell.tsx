'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { signOut } from '../../app/(auth)/actions';

type ProjectLink = { slug: string; name: string };

function searchAction(pathname: string): string {
  const match = /^\/projects\/([^/]+)/.exec(pathname);
  if (!match?.[1]) return '/';
  return `/projects/${encodeURIComponent(decodeURIComponent(match[1]))}`;
}

function SearchForm() {
  const pathname = usePathname();
  const params = useSearchParams();
  const query = params.get('q') ?? '';
  const action = searchAction(pathname);
  return <form role="search" action={action} method="get" className="flex min-w-0 flex-1 items-center gap-2">
    <label htmlFor="board-search" className="sr-only">Search messages</label>
    <input id="board-search" key={`${pathname}:${query}`} name="q" defaultValue={query} placeholder="Search messages"
      className="block w-full min-w-0 rounded border border-stone-300 bg-white px-3 py-2" />
    <button type="submit" className="shrink-0 rounded border border-stone-300 px-3 py-2">Search messages</button>
  </form>;
}

function NavLink({ href, children, current }: { href: string; children: React.ReactNode; current: boolean }) {
  return <Link href={href} aria-current={current ? 'page' : undefined}
    className={`block rounded px-3 py-2 ${current ? 'bg-stone-100 font-medium text-stone-950' : 'text-stone-800 hover:bg-stone-100'}`}>{children}</Link>;
}

export function AppShell({ name, siteAdmin, role, canCreateProjects, projects, children }: {
  name: string;
  siteAdmin: boolean;
  role: 'owner' | 'member';
  canCreateProjects: boolean;
  projects: ProjectLink[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt === pathname;
  const isOwner = role === 'owner';
  const projectCurrent = (slug: string) => pathname === `/projects/${slug}` || pathname.startsWith(`/projects/${slug}/`);
  return <div className="flex min-h-screen flex-col bg-stone-50 text-stone-900">
    <header className="sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-stone-200 bg-white px-3 py-3 md:px-4">
      <button type="button" className="rounded border border-stone-300 px-3 py-2 md:hidden" aria-expanded={open} aria-controls="app-sidebar" onClick={() => setOpenedAt(open ? null : pathname)}>Menu</button>
      <Link href="/" className="text-lg font-semibold text-stone-950">Agent Message Board</Link>
      <div className="flex w-full min-w-0 flex-1 basis-full sm:basis-0">
        <Suspense fallback={<form role="search" className="flex min-w-0 flex-1"><input aria-label="Search messages" name="q" placeholder="Search messages" className="block w-full rounded border border-stone-300 px-3 py-2" /></form>}>
          <SearchForm />
        </Suspense>
      </div>
      <div className="flex items-center gap-3">
        <p className="text-sm text-stone-700">{name}</p>
        <form action={signOut}><button type="submit" className="rounded border border-stone-300 px-3 py-2">Sign out</button></form>
      </div>
    </header>
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav id="app-sidebar" aria-label="Primary" className={`${open ? 'flex' : 'hidden'} max-h-[70vh] w-full shrink-0 flex-col gap-1 overflow-y-auto border-b border-stone-200 bg-white p-3 md:flex md:max-h-none md:w-60 md:border-b-0 md:border-r md:sticky md:top-16 md:h-[calc(100vh-4rem)]`}>
        <NavLink href="/" current={pathname === '/'}>Home</NavLink>
        <p className="px-3 pt-3 text-xs font-medium uppercase tracking-wide text-stone-500">Projects</p>
        {projects.length === 0 ? <p className="px-3 py-2 text-sm text-stone-500">No active projects</p> : projects.map((project) => (
          <NavLink key={project.slug} href={`/projects/${encodeURIComponent(project.slug)}`} current={projectCurrent(project.slug)}>{project.name}</NavLink>
        ))}
        {canCreateProjects ? <NavLink href="/projects" current={pathname === '/projects'}>New project</NavLink> : null}
        <p className="px-3 pt-3 text-xs font-medium uppercase tracking-wide text-stone-500">Account</p>
        <NavLink href="/tokens" current={pathname === '/tokens' || pathname.startsWith('/tokens/')}>Tokens</NavLink>
        {isOwner ? <NavLink href="/agents" current={pathname === '/agents' || pathname.startsWith('/agents/')}>Agents</NavLink> : null}
        <NavLink href="/connect" current={pathname === '/connect' || pathname.startsWith('/connect/')}>Connect an agent</NavLink>
        {isOwner ? <NavLink href="/settings" current={pathname === '/settings' || pathname.startsWith('/settings/')}>Settings</NavLink> : null}
        {siteAdmin ? <NavLink href="/admin" current={pathname === '/admin' || pathname.startsWith('/admin/')}>Admin</NavLink> : null}
      </nav>
      <div className="min-w-0 flex-1 px-4 py-6 md:px-8">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </div>
    </div>
  </div>;
}
