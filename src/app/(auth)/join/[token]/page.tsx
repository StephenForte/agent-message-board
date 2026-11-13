import Link from 'next/link';
import { headers } from 'next/headers';
import { inspectMemberInvite } from '../../../../domain/members';
import { getHumanPrincipal } from '../../../../auth/principal';
import { joinOrganization } from '../../actions';
import { buttonClass } from '../../fields';

export default async function Join({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ message?: string }>;
}) {
  const { token } = await params;
  const message = (await searchParams).message;
  const invitation = await inspectMemberInvite(token);
  if (!invitation) {
    return <>
      <h1>Invalid invitation link</h1>
      <p>Ask the organization owner for a current, unused invitation link.</p>
    </>;
  }
  const principal = await getHumanPrincipal(await headers());
  const query = new URLSearchParams({ returnTo: `/join/${token}` });
  return <>
    <h1 className="text-2xl font-semibold">Join {invitation.orgName}</h1>
    <p>Use the verified email address {invitation.email}. Each person can belong to one organization.</p>
    {message === 'wrong-email' ? <p role="alert">Sign in with the invited, verified email address ({invitation.email}).</p> : null}
    {principal ? <form action={joinOrganization}>
      <input type="hidden" name="token" value={token} />
      <button className={buttonClass}>Join organization</button>
    </form> : <p>
      <Link className="underline" href={`/sign-in?${query}`}>Sign in</Link> or{' '}
      <Link className="underline" href={`/sign-up?${query}`}>create an account</Link> with the invited email, then return to this link.
    </p>}
  </>;
}
