'use client';

import { useActionState, useState } from 'react';
import {
  createInviteLink, restoreOrganizationAction, savePublicAddress, setOwner, suspendOrganizationAction,
  type AdminResult,
} from '../../actions';

const empty: AdminResult = { message: '' };
const inputClass = 'mt-1 block w-full min-w-0 max-w-full rounded border border-stone-300 bg-white px-3 py-2';
const buttonClass = 'rounded border border-stone-300 bg-white px-3 py-2 disabled:opacity-50';
const confirmClass = 'rounded border border-stone-800 bg-stone-800 px-3 py-2 text-white disabled:opacity-50';

function FieldAlert({ id, message }: { id: string; message: string }) {
  return <p id={id} role="alert" className="mt-1 text-sm font-medium text-stone-800">{message}</p>;
}

export function OwnerPanel({ id, ownerEmail }: { id: string; ownerEmail: string | null }) {
  return <div className="min-w-0 space-y-4">
    {ownerEmail ? <p className="break-all">{ownerEmail}</p> : <p>No owner</p>}
    <div className="min-w-0 space-y-2">
      <h3 className="text-base font-medium text-stone-950">{ownerEmail ? 'Change owner' : 'Set owner'}</h3>
      <p className="text-sm text-stone-600">For someone who already has a verified account.</p>
      <SetOwnerForm id={id} />
    </div>
    {ownerEmail ? null : <InviteForm id={id} />}
  </div>;
}

function SetOwnerForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState(setOwner, empty);
  const error = state.field === 'email' ? state.message : '';
  return <form action={action} className="min-w-0 space-y-3">
    <input type="hidden" name="id" value={id} />
    <div className="min-w-0">
      <label htmlFor={`owner-email-${id}`} className="block text-sm font-medium">Owner email</label>
      <input id={`owner-email-${id}`} name="email" type="email" required maxLength={320} autoComplete="email"
        aria-invalid={error ? true : undefined} aria-describedby={error ? `owner-email-error-${id}` : undefined} className={inputClass} />
      {error ? <FieldAlert id={`owner-email-error-${id}`} message={error} /> : null}
    </div>
    <button type="submit" disabled={pending} className={buttonClass}>{pending ? 'Saving…' : 'Set owner'}</button>
    {state.message && !state.field ? <p role="status" className="text-sm text-stone-700">{state.message}</p> : null}
  </form>;
}

function InviteForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState(createInviteLink, empty);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const error = state.field === 'email' ? state.message : '';
  const activationUrl = state.activationUrl;
  return <form action={action} className="min-w-0 space-y-3">
    <input type="hidden" name="id" value={id} />
    <div className="min-w-0 space-y-2">
      <h3 className="text-base font-medium text-stone-950">Create invite link</h3>
      <p className="text-sm text-stone-600">For someone who does not have an account yet. The link is shown once and lasts 72 hours.</p>
    </div>
    <div className="min-w-0">
      <label htmlFor={`invite-email-${id}`} className="block text-sm font-medium">Invite email</label>
      <input id={`invite-email-${id}`} name="email" type="email" required maxLength={320} autoComplete="email"
        aria-invalid={error ? true : undefined} aria-describedby={error ? `invite-email-error-${id}` : undefined} className={inputClass} />
      {error ? <FieldAlert id={`invite-email-error-${id}`} message={error} /> : null}
    </div>
    <button type="submit" disabled={pending} className={buttonClass}>{pending ? 'Creating…' : 'Create invite link'}</button>
    {activationUrl ? <div className="min-w-0 space-y-2">
      <p role="status" className="text-sm text-stone-700">{state.message}</p>
      <input readOnly aria-label="Activation link" value={activationUrl} className={inputClass} />
      <button type="button" className={buttonClass} onClick={async () => {
        try {
          await navigator.clipboard.writeText(activationUrl);
          setCopiedUrl(activationUrl);
        } catch {
          setCopiedUrl(null);
        }
      }}>{copiedUrl === activationUrl ? 'Copied' : 'Copy'}</button>
    </div> : state.message && !state.field ? <p role="alert" className="text-sm font-medium text-stone-800">{state.message}</p> : null}
  </form>;
}

export function PublicAddressForm({ id, slug }: { id: string; slug: string | null }) {
  const [state, action, pending] = useActionState(savePublicAddress, empty);
  const error = state.field === 'slug' ? state.message : '';
  const describedBy = error ? 'public-address-error public-address-hint' : 'public-address-hint';
  return <form action={action} className="min-w-0 space-y-3">
    <input type="hidden" name="id" value={id} />
    <div className="min-w-0">
      <label htmlFor="public-address" className="block text-sm font-medium">Public address</label>
      <input id="public-address" name="slug" required maxLength={40} defaultValue={slug ?? ''} autoCapitalize="none" autoCorrect="off" spellCheck={false}
        aria-invalid={error ? true : undefined} aria-describedby={describedBy} className={inputClass} />
      {error ? <FieldAlert id="public-address-error" message={error} /> : null}
      <p id="public-address-hint" className="mt-1 text-sm text-stone-600">2–40 lowercase letters, digits, hyphens; starts with a letter or digit</p>
    </div>
    <button type="submit" disabled={pending} className={buttonClass}>{pending ? 'Saving…' : 'Save public address'}</button>
    {state.message && !state.field ? <p role="status" className="text-sm text-stone-700">{state.message}</p> : null}
  </form>;
}

export function StatusSection({ id, status }: { id: string; status: 'active' | 'suspended' }) {
  const [suspendState, suspendAction, suspendPending] = useActionState(suspendOrganizationAction, empty);
  const [restoreState, restoreAction, restorePending] = useActionState(restoreOrganizationAction, empty);
  const [confirming, setConfirming] = useState(false);
  const [last, setLast] = useState<'suspend' | 'restore' | null>(null);
  const pending = suspendPending || restorePending;
  const notice = last === 'suspend' ? suspendState : last === 'restore' ? restoreState : empty;
  const failed = Boolean(notice.message) && !pending && (
    (last === 'suspend' && status !== 'suspended') || (last === 'restore' && status !== 'active')
  );
  const showConfirmation = confirming && status === 'active' && last !== 'restore';
  return <div className="min-w-0 space-y-3">
    {status === 'suspended' ? <form action={restoreAction} onSubmit={() => setLast('restore')}>
      <input type="hidden" name="id" value={id} />
      <button type="submit" disabled={restorePending} className={buttonClass}>{restorePending ? 'Restoring…' : 'Restore organization'}</button>
    </form> : showConfirmation ? <form action={suspendAction} onSubmit={() => setLast('suspend')} className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <p>The owner sees the suspended page, agents get org_suspended, and public pages return 404, until the organization is restored.</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={suspendPending} className={confirmClass}>{suspendPending ? 'Suspending…' : 'Confirm suspend'}</button>
        <button type="button" className={buttonClass} onClick={() => setConfirming(false)}>Cancel</button>
      </div>
    </form> : <button type="button" className={buttonClass} onClick={() => { setLast(null); setConfirming(true); }}>Suspend organization</button>}
    {notice.message && !pending ? <p role={failed ? 'alert' : 'status'} className="text-sm text-stone-700">{notice.message}</p> : null}
  </div>;
}
