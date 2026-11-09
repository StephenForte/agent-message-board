'use client';
import { useActionState, useState } from 'react';
import { mutateOrganization } from './actions';
export function AdminForm({ operation, id }: { operation: 'create' | 'associate' | 'activate' | 'suspend' | 'restore'; id?: string }) {
  const [state, action, pending] = useActionState(mutateOrganization, { message: '' });
  const [copied, setCopied] = useState(false);
  const label = { create: 'Create organization', associate: 'Associate owner', activate: 'Issue activation link', suspend: 'Suspend', restore: 'Restore' }[operation];
  return <div className="space-y-2"><form action={action} className="flex flex-wrap items-end gap-3">
    <input type="hidden" name="operation" value={operation} /><input type="hidden" name="id" value={id ?? ''} />
    {operation === 'create' && <label>Name<input name="name" required maxLength={200} className="block rounded border p-2" /></label>}
    {['create', 'associate', 'activate'].includes(operation) && <label>{operation === 'create' ? 'Owner email (optional)' : 'Owner email'}
      <input name="email" type="email" required={operation !== 'create'} maxLength={320} className="block rounded border p-2" /></label>}
    <button disabled={pending} className="rounded border px-3 py-2 disabled:opacity-50">{pending ? 'Saving…' : label}</button>
  </form><p role="status">{state.message}</p>{state.activationUrl && <div className="space-y-2">
    <input readOnly aria-label="Activation link" value={state.activationUrl} className="w-full rounded border p-2" />
    <button className="underline" onClick={async () => { try { await navigator.clipboard.writeText(state.activationUrl!); setCopied(true); } catch { setCopied(false); } }}>
      {copied ? 'Copied' : 'Copy activation link'}</button></div>}</div>;
}
