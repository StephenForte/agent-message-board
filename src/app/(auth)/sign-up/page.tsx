import Link from 'next/link';
import { signUp } from '../actions';
import { Field, Notice, buttonClass } from '../fields';
import { safeActivationReturn } from '../../../auth/web';
export default async function SignUp({ searchParams }: { searchParams: Promise<{ message?: string; returnTo?: string }> }) {
  const query = await searchParams; const next = safeActivationReturn(query.returnTo);
  return <><h1 className="text-2xl font-semibold">Create an account</h1><Notice code={query.message} />
    <form action={signUp} className="space-y-4"><Field name="name" label="Name" /><Field name="email" label="Email" type="email" />
    <Field name="password" label="Password (at least 8 characters)" type="password" autoComplete="new-password" />
    <input type="hidden" name="returnTo" value={next ?? ''} /><button className={buttonClass}>Create account</button></form>
    <p><Link className="underline" href={next ? `/sign-in?${new URLSearchParams({ returnTo: next })}` : '/sign-in'}>Sign in</Link></p></>;
}
