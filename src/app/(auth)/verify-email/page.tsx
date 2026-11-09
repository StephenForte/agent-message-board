import Link from 'next/link';
import { Notice } from '../fields';
import { safeActivationReturn } from '../../../auth/web';
export default async function Verify({ searchParams }: { searchParams: Promise<{ message?: string; error?: string; returnTo?: string }> }) {
  const query = await searchParams; const next = safeActivationReturn(query.returnTo);
  return <><h1 className="text-2xl font-semibold">Email verification</h1><Notice code={query.message} />
    <p>{query.error ? 'This verification link is invalid or expired. Sign in to request another verification email.'
      : query.message === 'verification-sent' ? 'Return here after following the link in your email.' : 'Email verification complete. You can now sign in.'}</p>
    <Link className="underline" href={next ? `/sign-in?${new URLSearchParams({ returnTo: next })}` : '/sign-in'}>Sign in</Link></>;
}
