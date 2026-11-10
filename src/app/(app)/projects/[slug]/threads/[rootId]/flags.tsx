'use client';

import { useActionState } from 'react';
import { formatFlagState } from '../../composer-model';
import { updateFlagsAction, type FlagFormState, type FlagIntent, type FlagSnapshot } from './actions';

const initial: FlagFormState = { alert: null, conflict: null };

function ChangeForm({ action, version, idempotencyKey, label, name, value }: {
  action: (formData: FormData) => void;
  version: number;
  idempotencyKey: string;
  label: string;
  name: string;
  value: string;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="expectedVersion" value={version} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <button type="submit" className="rounded border px-3 py-2" name={name} value={value}>{label}</button>
    </form>
  );
}

function ReapplyForm({ action, current, intent, idempotencyKey }: {
  action: (formData: FormData) => void;
  current: FlagSnapshot;
  intent: FlagIntent;
  idempotencyKey: string;
}) {
  return (
    <form action={action} className="space-y-3">
      <p role="alert">This thread changed. Current state: {formatFlagState(current)}. Re-apply your change, or reload to keep the current state.</p>
      <input type="hidden" name="expectedVersion" value={current.version} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {intent.status ? <input type="hidden" name="status" value={intent.status} /> : null}
      {intent.urgent !== undefined ? <input type="hidden" name="urgent" value={String(intent.urgent)} /> : null}
      {intent.pinned !== undefined ? <input type="hidden" name="pinned" value={String(intent.pinned)} /> : null}
      <button type="submit" className="rounded bg-blue-700 px-4 py-2 font-medium text-white">Re-apply</button>
    </form>
  );
}

export function FlagControls({ slug, rootId, snapshot, keys }: {
  slug: string;
  rootId: string;
  snapshot: FlagSnapshot;
  keys: { urgent: string; pinned: string; status: string };
}) {
  const [state, action, pending] = useActionState(updateFlagsAction.bind(null, slug, rootId), initial);
  return (
    <div className="space-y-3" aria-busy={pending}>
      {state.alert ? <p role="alert" className="rounded border border-red-700 p-3">{state.alert}</p> : null}
      {state.conflict ? <ReapplyForm action={action} {...state.conflict} /> : (
        <div className="flex flex-wrap gap-2">
          <ChangeForm action={action} version={snapshot.version} idempotencyKey={keys.urgent} name="urgent" value={snapshot.urgent ? 'false' : 'true'} label={snapshot.urgent ? 'Clear urgent' : 'Mark urgent'} />
          <ChangeForm action={action} version={snapshot.version} idempotencyKey={keys.pinned} name="pinned" value={snapshot.pinned ? 'false' : 'true'} label={snapshot.pinned ? 'Unpin' : 'Pin'} />
          <ChangeForm action={action} version={snapshot.version} idempotencyKey={keys.status} name="status" value={snapshot.status === 'archived' ? 'active' : 'archived'} label={snapshot.status === 'archived' ? 'Restore' : 'Archive'} />
        </div>
      )}
    </div>
  );
}
