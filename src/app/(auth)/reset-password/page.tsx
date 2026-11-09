import Link from 'next/link';
import { resetPassword } from '../actions';
import { Field, buttonClass } from '../fields';
export default async function Reset({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const query = await searchParams;
  if (!query.token || query.error) return <><h1>Invalid reset link</h1><Link href="/forgot-password">Request a new reset link</Link></>;
  return <><h1 className="text-2xl font-semibold">Choose a new password</h1>
    <form action={resetPassword} className="space-y-4"><Field name="password" label="New password" type="password" />
    <input type="hidden" name="token" value={query.token} /><button className={buttonClass}>Update password</button></form></>;
}
