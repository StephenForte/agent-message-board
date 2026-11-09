import { redirect } from 'next/navigation';
import { requireHuman } from '../../../auth/web';
import { humanLanding } from '../../../domain/organizations';
import { signOut } from '../actions';
import { buttonClass } from '../fields';
export default async function Suspended() {
  const principal = await requireHuman(); const landing = await humanLanding(principal);
  if (landing !== '/suspended') redirect(landing);
  return <><h1 className="text-2xl font-semibold">This organization is suspended</h1>
    <p>Contact your administrator to restore access.</p><form action={signOut}><button className={buttonClass}>Sign out</button></form></>;
}
