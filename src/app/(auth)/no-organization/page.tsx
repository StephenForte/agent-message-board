import { redirect } from 'next/navigation';
import { requireHuman } from '../../../auth/web';
import { humanLanding } from '../../../domain/organizations';
import { signOut } from '../actions';
import { Notice, buttonClass } from '../fields';
export default async function NoOrg({ searchParams }: { searchParams: Promise<{ message?: string }> }) {
  const principal = await requireHuman(); const landing = await humanLanding(principal);
  if (landing !== '/no-organization') redirect(landing);
  return <><h1 className="text-2xl font-semibold">No organization yet</h1><Notice code={(await searchParams).message} />
    <p>Ask your administrator to associate your verified email or send an activation link.</p>
    <form action={signOut}><button className={buttonClass}>Sign out</button></form></>;
}
