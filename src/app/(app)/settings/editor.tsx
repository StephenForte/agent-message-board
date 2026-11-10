'use client';

import { useActionState, useState } from 'react';
import { Markdown } from '../../../components/markdown/Markdown';
import { emptyAnnouncementState, type AnnouncementFormState } from './announcement-state';

type Action = (state: AnnouncementFormState, data: FormData) => Promise<AnnouncementFormState>;

export function AnnouncementEditor({
  expectedVersion,
  initialTitle,
  initialBody,
  canClear,
  saveAction,
  clearAction,
}: {
  expectedVersion: number;
  initialTitle: string;
  initialBody: string;
  canClear: boolean;
  saveAction: Action;
  clearAction: Action;
}) {
  const [version, setVersion] = useState(expectedVersion);
  const [seenVersion, setSeenVersion] = useState(expectedVersion);
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [saveState, saveForm, savePending] = useActionState(saveAction, emptyAnnouncementState);
  const [clearState, clearForm, clearPending] = useActionState(clearAction, emptyAnnouncementState);
  const [seenSave, setSeenSave] = useState(saveState);
  const [seenClear, setSeenClear] = useState(clearState);
  if (expectedVersion !== seenVersion) {
    setSeenVersion(expectedVersion);
    setVersion(expectedVersion);
  }
  if (saveState !== seenSave) {
    setSeenSave(saveState);
    if (saveState.conflict) {
      setVersion(saveState.conflict.currentVersion);
      if (saveState.draftTitle !== undefined) setTitle(saveState.draftTitle);
      if (saveState.draftBody !== undefined) setBody(saveState.draftBody);
    } else if (typeof saveState.version === 'number') setVersion(saveState.version);
  }
  if (clearState !== seenClear) {
    setSeenClear(clearState);
    if (clearState.cleared) {
      setTitle('');
      setBody('');
      if (typeof clearState.version === 'number') setVersion(clearState.version);
    }
  }
  const busy = savePending || clearPending;
  return <div className="space-y-4">
    <p>Based on version {version}.</p>
    {saveState.conflict ? <p role="alert">{saveState.message}</p> : null}
    <form action={saveForm} className="space-y-3">
      <input type="hidden" name="expectedVersion" value={String(version)} />
      <label className="block">Title
        <input name="title" required value={title} onChange={(event) => setTitle(event.target.value)} aria-invalid={saveState.field === 'title'} aria-describedby={saveState.field === 'title' ? 'announcement-title-error' : undefined} className="mt-1 block w-full max-w-xl rounded border p-2" />
      </label>
      {saveState.field === 'title' ? <p id="announcement-title-error" role="alert">{saveState.message}</p> : null}
      <label className="block">Body
        <textarea name="body" rows={8} value={body} onChange={(event) => setBody(event.target.value)} aria-invalid={saveState.field === 'body'} aria-describedby={saveState.field === 'body' ? 'announcement-body-error' : undefined} className="mt-1 block w-full max-w-xl rounded border p-2" />
      </label>
      {saveState.field === 'body' ? <p id="announcement-body-error" role="alert">{saveState.message}</p> : null}
      <button type="submit" disabled={busy} className="rounded border px-3 py-2 disabled:opacity-50">{savePending ? 'Saving…' : 'Save announcement'}</button>
      {saveState.message && !saveState.field && !saveState.conflict && !clearState.cleared ? <p role="status">{saveState.message}</p> : null}
    </form>
    <section aria-labelledby="announcement-preview" className="space-y-2 rounded border p-4">
      <h2 id="announcement-preview" className="text-lg font-medium">Preview</h2>
      {body ? <Markdown>{body}</Markdown> : <p>Nothing to preview.</p>}
    </section>
    {canClear ? <form action={clearForm} className="space-y-2">
      <input type="hidden" name="expectedVersion" value={String(version)} />
      <button type="submit" disabled={busy} className="rounded border px-3 py-2 disabled:opacity-50">{clearPending ? 'Clearing…' : 'Clear announcement'}</button>
    </form> : null}
    {clearState.message ? <p role="status">{clearState.message}</p> : null}
  </div>;
}
