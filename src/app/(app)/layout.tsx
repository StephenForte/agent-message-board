import Link from 'next/link';
import { signOut } from '../(auth)/actions';
import { getOwnerProfile } from '../../domain/orghome';
import { ownerPrincipal, raiseDomain } from './session';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const principal = await ownerPrincipal();
  let name = 'Owner';
  try {
    name = (await getOwnerProfile(principal)).name;
  } catch (error) {
    raiseDomain(error);
  }
  return <div className="mx-auto max-w-5xl space-y-6 px-6 py-10">
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <p className="text-lg font-semibold"><Link href="/">Agent Message Board</Link></p>
        <p>Signed in as {name}</p>
      </div>
      <form action={signOut}><button type="submit" className="rounded border px-3 py-2">Sign out</button></form>
    </header>
    <nav aria-label="Primary" className="flex flex-wrap gap-4">
      <Link href="/" className="underline">Home</Link>
      <Link href="/projects" className="underline">Projects</Link>
      <Link href="/tokens" className="underline">Tokens</Link>
      <Link href="/agents" className="underline">Agents</Link>
      <Link href="/connect" className="underline">Connect</Link>
      <Link href="/settings" className="underline">Settings</Link>
      {principal.siteAdmin ? <Link href="/admin" className="underline">Admin</Link> : null}
    </nav>
    {children}
  </div>;
}
