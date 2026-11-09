import { forgotPassword } from '../actions';
import { Field, Notice, buttonClass } from '../fields';
export default async function Forgot({ searchParams }: { searchParams: Promise<{ message?: string }> }) {
  return <><h1 className="text-2xl font-semibold">Reset your password</h1><Notice code={(await searchParams).message} />
    <form action={forgotPassword} className="space-y-4"><Field name="email" label="Email" type="email" />
    <button className={buttonClass}>Send reset link</button></form></>;
}
