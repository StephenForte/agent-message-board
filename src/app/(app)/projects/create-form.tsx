'use client';

import { useActionState, useState } from 'react';
import { createProjectAction, type ProjectFormState } from './actions';

const initial: ProjectFormState = { message: '' };

export function CreateProjectForm({ idempotencyKey }: { idempotencyKey: string }) {
  const [state, action, pending] = useActionState(createProjectAction, initial);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  return <form action={action} className="space-y-3">
    <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
    <label className="block">Name
      <input name="name" required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} aria-invalid={state.field === 'name'} aria-describedby={state.field === 'name' ? 'name-error' : undefined} className="mt-1 block w-full max-w-md rounded border p-2" />
    </label>
    {state.field === 'name' ? <p id="name-error" role="alert">{state.message}</p> : null}
    <label className="block">Slug
      <input name="slug" required maxLength={63} value={slug} onChange={(event) => setSlug(event.target.value)} aria-invalid={state.field === 'slug'} aria-describedby={state.field === 'slug' ? 'slug-error' : undefined} className="mt-1 block w-full max-w-md rounded border p-2" />
    </label>
    {state.field === 'slug' ? <p id="slug-error" role="alert">{state.message}</p> : null}
    <label className="block">Description
      <textarea name="description" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} aria-invalid={state.field === 'description'} aria-describedby={state.field === 'description' ? 'description-error' : undefined} className="mt-1 block w-full max-w-md rounded border p-2" />
    </label>
    {state.field === 'description' ? <p id="description-error" role="alert">{state.message}</p> : null}
    <button type="submit" disabled={pending} className="rounded border px-3 py-2 disabled:opacity-50">{pending ? 'Creating…' : 'Create project'}</button>
    {state.message && !state.field ? <p role="status">{state.message}</p> : null}
  </form>;
}
