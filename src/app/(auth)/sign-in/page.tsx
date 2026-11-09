import Link from 'next/link';
import { signIn } from '../actions';
import { Field, Notice, buttonClass } from '../fields';
import { safeActivationReturn } from '../../../auth/web';
export default async function SignIn({ searchParams }: { searchParams: Promise<{ message?: string; returnTo?: string }> }) {
  const query = await searchParams;
  const next = safeActivationReturn(query.returnTo);
  return <><h1 className="text-2xl font-semibold">Sign in</h1><Notice code={query.message} />
    <form action={signIn} className="space-y-4"><Field name="email" label="Email" type="email" />
      <Field name="password" label="Password" type="password" /><input type="hidden" name="returnTo" value={next ?? ''} />
      <button className={buttonClass}>Sign in</button></form>
    <p><Link className="underline" href={next ? `/sign-up?${new URLSearchParams({ returnTo: next })}` : '/sign-up'}>Create an account</Link></p>
    <p><Link className="underline" href="/forgot-password">Forgot password?</Link></p></>;
}
