'use client';

import { useActionState, useState } from 'react';
import type { ProjectSettingsState } from './actions';

const initial: ProjectSettingsState = { message: '' };
type SettingsAction = (state: ProjectSettingsState, data: FormData) => Promise<ProjectSettingsState>;

export function RenameForm({ action, name, description }: { action: SettingsAction; name: string; description: string }) {
  const [state, formAction, pending] = useActionState(action, initial);
  const [nameValue, setNameValue] = useState(name);
  const [descriptionValue, setDescriptionValue] = useState(description);
  return <form action={formAction} className="space-y-3">
    <label className="block">Name
      <input name="name" required maxLength={200} value={nameValue} onChange={(event) => setNameValue(event.target.value)} aria-invalid={state.field === 'name'} aria-describedby={state.field === 'name' ? 'settings-name-error' : undefined} className="mt-1 block w-full max-w-md rounded border p-2" />
    </label>
    {state.field === 'name' ? <p id="settings-name-error" role="alert">{state.message}</p> : null}
    <label className="block">Description
      <textarea name="description" rows={4} value={descriptionValue} onChange={(event) => setDescriptionValue(event.target.value)} aria-invalid={state.field === 'description'} aria-describedby={state.field === 'description' ? 'settings-description-error' : undefined} className="mt-1 block w-full max-w-md rounded border p-2" />
    </label>
    {state.field === 'description' ? <p id="settings-description-error" role="alert">{state.message}</p> : null}
    <button type="submit" disabled={pending} className="rounded border px-3 py-2 disabled:opacity-50">{pending ? 'Saving…' : 'Save project'}</button>
    {state.message && !state.field ? <p role="status">{state.message}</p> : null}
  </form>;
}

export function ArchiveForm({ action }: { action: SettingsAction }) {
  const [state, formAction, pending] = useActionState(action, initial);
  return <form action={formAction} className="space-y-2">
    <button type="submit" disabled={pending} className="rounded border px-3 py-2 disabled:opacity-50">{pending ? 'Archiving…' : 'Archive project'}</button>
    {state.message ? <p role="status">{state.message}</p> : null}
  </form>;
}

export function RestoreForm({ action }: { action: SettingsAction }) {
  const [state, formAction, pending] = useActionState(action, initial);
  return <form action={formAction} className="space-y-2">
    <button type="submit" disabled={pending} className="rounded border px-3 py-2 disabled:opacity-50">{pending ? 'Restoring…' : 'Restore project'}</button>
    {state.message ? <p role="status">{state.message}</p> : null}
  </form>;
}
