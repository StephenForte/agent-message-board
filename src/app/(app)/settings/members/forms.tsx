'use client';

import { useActionState, useState } from 'react';
import { TimeStamp } from '../../../../components/board/time';
import {
  inviteMemberAction, removeMemberAction, revokeInviteAction, setCanCreateProjectsAction,
  type InviteFormState,
} from './actions';

const initial: InviteFormState = {};

export function InviteMemberForm() {
  const [state, action, pending] = useActionState(inviteMemberAction, initial);
  return <section aria-labelledby="invite-heading" className="space-y-3 rounded border p-4">
    <h2 id="invite-heading" className="text-xl font-medium">Invite member</h2>
    <form action={action} className="space-y-3">
      <label className="block space-y-1">
        <span>Email</span>
        <input name="email" type="email" required className="block w-full rounded border p-2" />
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" name="canCreateProjects" />
        <span>Can create projects</span>
      </label>
      <button type="submit" disabled={pending} className="rounded bg-blue-700 px-4 py-2 font-medium text-white disabled:opacity-50">
        {pending ? 'Creating invite…' : 'Create invite link'}
      </button>
    </form>
    {state.message ? <p role="status">{state.message}</p> : null}
    {state.link ? <InviteLinkOnce link={state.link} expiresAt={state.expiresAt} /> : null}
  </section>;
}

function InviteLinkOnce({ link, expiresAt }: { link: string; expiresAt?: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3">
    <p className="font-medium">Invitation link (shown once)</p>
    <p className="break-all font-mono text-sm">{link}</p>
    <p>This link expires in 72 hours{expiresAt ? ` (${new Date(expiresAt).toISOString()})` : ''}.</p>
    <button type="button" className="rounded border px-3 py-2" onClick={async () => {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    }}>{copied ? 'Copied' : 'Copy'}</button>
  </div>;
}

export function PendingInviteRow({ id, email, expiresAt }: { id: string; email: string; expiresAt: string }) {
  return <li className="flex flex-wrap items-center justify-between gap-3 rounded border p-3">
    <div>
      <p className="font-medium">{email}</p>
      <p className="text-sm text-stone-600">Expires <TimeStamp iso={expiresAt} /></p>
    </div>
    <form action={revokeInviteAction.bind(null, id)}>
      <button type="submit" className="rounded border px-3 py-2">Revoke</button>
    </form>
  </li>;
}

export function MemberRow({
  id, email, name, joinedAt, canCreateProjects,
}: {
  id: string; email: string; name: string; joinedAt: string; canCreateProjects: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  return <li className="space-y-3 rounded border p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <div>
        <p className="font-medium">{name || email}</p>
        <p className="text-sm text-stone-600">{email}</p>
        <p className="text-sm text-stone-600">Joined <TimeStamp iso={joinedAt} /></p>
      </div>
      {!confirming ? <button type="button" className="rounded border px-3 py-2" onClick={() => setConfirming(true)}>Remove</button> : null}
    </div>
    <form action={setCanCreateProjectsAction.bind(null, id, !canCreateProjects)}>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={canCreateProjects} onChange={(event) => event.currentTarget.form?.requestSubmit()} />
        <span>Can create projects</span>
      </label>
    </form>
    {confirming ? <div className="space-y-2 rounded border border-red-300 bg-red-50 p-3">
      <p>Remove this member? Every unrevoked agent token they issued will be revoked. Messages they wrote stay.</p>
      <div className="flex gap-2">
        <form action={removeMemberAction.bind(null, id)}>
          <button type="submit" className="rounded bg-red-700 px-3 py-2 text-white">Confirm remove</button>
        </form>
        <button type="button" className="rounded border px-3 py-2" onClick={() => setConfirming(false)}>Cancel</button>
      </div>
    </div> : null}
  </li>;
}
