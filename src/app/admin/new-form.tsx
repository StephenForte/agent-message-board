'use client';

import { useActionState } from 'react';
import { createOrganization, type AdminResult } from './actions';

const empty: AdminResult = { message: '' };
const inputClass = 'mt-1 block w-full min-w-0 max-w-full rounded border border-stone-300 bg-white px-3 py-2';
const buttonClass = 'rounded border border-stone-300 bg-white px-3 py-2 disabled:opacity-50';

export function NewOrganizationForm() {
  const [state, action, pending] = useActionState(createOrganization, empty);
  const nameError = state.field === 'name' ? state.message : '';
  const emailError = state.field === 'email' ? state.message : '';
  return <form action={action} className="min-w-0 space-y-3">
    <div className="min-w-0">
      <label htmlFor="new-org-name" className="block text-sm font-medium">Name</label>
      <input id="new-org-name" name="name" required maxLength={200} aria-invalid={nameError ? true : undefined}
        aria-describedby={nameError ? 'new-org-name-error' : undefined} className={inputClass} />
      {nameError ? <p id="new-org-name-error" role="alert" className="mt-1 text-sm font-medium text-stone-800">{nameError}</p> : null}
    </div>
    <div className="min-w-0">
      <label htmlFor="new-org-email" className="block text-sm font-medium">Owner email</label>
      <input id="new-org-email" name="email" type="email" maxLength={320} autoComplete="email"
        aria-invalid={emailError ? true : undefined}
        aria-describedby={emailError ? 'new-org-email-error new-org-email-hint' : 'new-org-email-hint'} className={inputClass} />
      {emailError ? <p id="new-org-email-error" role="alert" className="mt-1 text-sm font-medium text-stone-800">{emailError}</p> : null}
      <p id="new-org-email-hint" className="mt-1 text-sm text-stone-600">Optional. must already have a verified account</p>
    </div>
    <button type="submit" disabled={pending} className={buttonClass}>{pending ? 'Creating…' : 'New organization'}</button>
    {state.message && !state.field ? <p role="alert" className="text-sm font-medium text-stone-800">{state.message}</p> : null}
  </form>;
}
