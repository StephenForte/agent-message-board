'use client';

import { useActionState } from 'react';
import { secondaryButton } from '../../tokens/format';
import { setAgentDefaultsAction, type MessageState } from './actions';

const blank: MessageState = { message: '' };

export function DefaultsForm({ agentId, projects, selectedIds }: {
  agentId: string;
  projects: { id: string; name: string }[];
  selectedIds: string[];
}) {
  const [state, action, pending] = useActionState(setAgentDefaultsAction, blank);
  const selected = new Set(selectedIds);
  return <form action={action} className="space-y-3">
    <input type="hidden" name="agentId" value={agentId} />
    <fieldset className="space-y-2">
      <legend className="font-medium">Default projects</legend>
      <p>Defaults choose where the agent works by default but never grant access.</p>
      {projects.length === 0 ? <p>No projects yet.</p> : <ul className="space-y-2">
        {projects.map((project) => <li key={project.id}><label className="flex items-center gap-2">
          <input type="checkbox" name="projectIds" value={project.id} defaultChecked={selected.has(project.id)} />
          {project.name}
        </label></li>)}
      </ul>}
    </fieldset>
    <button disabled={pending} className={secondaryButton}>{pending ? 'Saving defaults…' : 'Save defaults'}</button>
    {state.message ? <p role="status">{state.message}</p> : null}
  </form>;
}
