'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

function NavLink({ href, children, current }: { href: string; children: React.ReactNode; current: boolean }) {
  return <Link href={href} aria-current={current ? 'page' : undefined}
    className={`rounded px-3 py-2 ${current ? 'bg-stone-100 font-medium text-stone-950' : 'text-stone-800 hover:bg-stone-100'}`}>{children}</Link>;
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const announcement = pathname.startsWith('/admin/announcement');
  const organizations = pathname === '/admin' || pathname.startsWith('/admin/organizations');
  return <div className="min-h-screen bg-stone-50 text-stone-900">
    <header className="sticky top-0 z-20 border-b border-stone-200 bg-white">
      <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-3 py-3 md:px-4">
        <Link href="/admin" className="text-lg font-semibold text-stone-950">Agent Message Board</Link>
        <nav aria-label="Administration" className="flex min-w-0 flex-wrap items-center gap-1">
          <NavLink href="/admin" current={organizations}>Organizations</NavLink>
          <NavLink href="/admin/announcement" current={announcement}>Site announcement</NavLink>
          <NavLink href="/" current={false}>Back to the board</NavLink>
        </nav>
      </div>
    </header>
    <main className="mx-auto w-full min-w-0 max-w-6xl px-3 py-6 md:px-8">{children}</main>
  </div>;
}
