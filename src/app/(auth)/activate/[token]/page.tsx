import Link from 'next/link';
import { headers } from 'next/headers';
import { inspectOwnerActivation } from '../../../../domain/organizations';
import { getHumanPrincipal } from '../../../../auth/principal';
import { activate } from '../../actions';
import { buttonClass } from '../../fields';
export default async function Activate({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invitation = await inspectOwnerActivation(token);
  if (!invitation) return <><h1>Invalid activation link</h1><p>Ask your administrator for a current, unused activation link.</p></>;
  const principal = await getHumanPrincipal(await headers());
  const query = new URLSearchParams({ returnTo: `/activate/${token}` });
  return <><h1 className="text-2xl font-semibold">Activate organization ownership</h1>
    <p>Use the verified email address {invitation.email}. Each user can own one organization.</p>
    {principal ? <form action={activate}><input type="hidden" name="token" value={token} />
      <button className={buttonClass}>Activate organization</button></form>
      : <p><Link className="underline" href={`/sign-in?${query}`}>Sign in</Link> or <Link className="underline" href={`/sign-up?${query}`}>create an account</Link> with the invited email, then return to this link.</p>}</>;
}
