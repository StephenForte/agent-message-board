'use client';

import { useActionState, useState } from 'react';
import { defaultCanCreateProjects, scopeCopy, type TokenScope } from './copy';
import { formatWhen, inputClass, prefixLabel, primaryButton, secondaryButton } from './format';
import { createTokenAction, replaceTokenAction, revokeTokenAction, setTokenGrantsAction, type MessageState, type SecretState } from './actions';

export type ProjectChoice = { id: string; name: string };

export type TokenView = {
  id: string;
  label: string;
  prefix: string;
  scope: TokenScope;
  projectIds: string[];
  projectNames: string[];
  canCreateProjects: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

const blankSecret: SecretState = { message: '' };
const blankMessage: MessageState = { message: '' };

function CopySecret({ secret }: { secret: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="underline" onClick={() => {
    void navigator.clipboard.writeText(secret).then(() => setCopied(true), () => setCopied(false));
  }}>{copied ? 'Copied' : 'Copy secret'}</button>;
}

function SecretReveal({ secret, prefix, children }: { secret: string; prefix: string; children?: React.ReactNode }) {
  return <div role="region" aria-label="New token secret" className="space-y-3 rounded border border-amber-700 p-4">
    <p role="alert">Copy this secret now. It cannot be shown again.</p>
    <label className="block space-y-1">Token secret
      <input readOnly aria-label="Token secret" autoComplete="off" spellCheck={false} value={secret} className={`${inputClass} font-mono`} />
    </label>
    <p>Prefix {prefixLabel(prefix)}</p>
    <CopySecret secret={secret} />
    {children}
  </div>;
}

function ExpiryField() {
  const [iso, setIso] = useState('');
  return <>
    <label className="block space-y-1">Expiry (optional)
      <input className={inputClass} type="datetime-local" onChange={(event) => {
        const value = event.target.value;
        setIso(value ? new Date(value).toISOString() : '');
      }} />
    </label>
    <input type="hidden" name="expiresAt" value={iso} />
  </>;
}

function ProjectChoices({ projects, selected }: { projects: ProjectChoice[]; selected?: ReadonlySet<string> }) {
  if (projects.length === 0) return <p>No projects yet.</p>;
  return <ul className="space-y-2">
    {projects.map((project) => <li key={project.id}><label className="flex items-center gap-2">
      <input type="checkbox" name="projectIds" value={project.id} defaultChecked={selected?.has(project.id) ?? false} />
      {project.name}
    </label></li>)}
  </ul>;
}

export function CreateTokenForm({ projects }: { projects: ProjectChoice[] }) {
  const [state, action, pending] = useActionState(createTokenAction, blankSecret);
  const [scope, setScope] = useState<TokenScope>('org');
  const [canCreate, setCanCreate] = useState(true);
  function choose(next: TokenScope) {
    setScope(next);
    setCanCreate(defaultCanCreateProjects(next));
  }
  return <div className="space-y-4">
    <form action={action} className="space-y-4">
      <label className="block space-y-1">Label
        <input name="label" required maxLength={200} autoComplete="off" className={inputClass} />
      </label>
      <fieldset className="space-y-3">
        <legend className="font-medium">Scope</legend>
        <label className="flex items-center gap-2"><input type="radio" name="scope" value="org" checked={scope === 'org'} onChange={() => choose('org')} />Broad</label>
        <p>{scopeCopy('org')}</p>
        <label className="flex items-center gap-2"><input type="radio" name="scope" value="projects" checked={scope === 'projects'} onChange={() => choose('projects')} />Restricted</label>
        <p>{scopeCopy('projects')}</p>
      </fieldset>
      {scope === 'projects' ? <fieldset className="space-y-2">
        <legend className="font-medium">Projects</legend>
        <ProjectChoices projects={projects} />
      </fieldset> : null}
      <label className="flex items-center gap-2">
        <input type="checkbox" name="canCreateProjects" value="true" checked={canCreate} onChange={(event) => setCanCreate(event.target.checked)} />
        Can create projects
      </label>
      <ExpiryField />
      <button disabled={pending} className={primaryButton}>{pending ? 'Creating token…' : 'Create token'}</button>
    </form>
    {state.message ? <p role="status">{state.message}</p> : null}
    {state.secret && state.prefix ? <SecretReveal secret={state.secret} prefix={state.prefix} /> : null}
  </div>;
}

export function RevokeControl({ tokenId, label, prefix, offer }: { tokenId: string; label: string; prefix: string; offer?: 'old' }) {
  const [state, action, pending] = useActionState(revokeTokenAction, blankMessage);
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return <button type="button" className={secondaryButton} onClick={() => setArmed(true)}>
      {offer === 'old' ? 'Revoke the old token' : 'Revoke'}
    </button>;
  }
  return <form action={action} className="space-y-2">
    <input type="hidden" name="tokenId" value={tokenId} />
    <p>Revoke {label} ({prefixLabel(prefix)})? This cannot be undone.</p>
    <div className="flex flex-wrap gap-3">
      <button disabled={pending} className={secondaryButton}>{pending ? 'Revoking…' : `Revoke ${label}`}</button>
      <button type="button" className="underline" onClick={() => setArmed(false)}>Cancel</button>
    </div>
    {state.message ? <p role="status">{state.message}</p> : null}
  </form>;
}

export function ReplaceControl({ token }: { token: TokenView }) {
  const [state, action, pending] = useActionState(replaceTokenAction, blankSecret);
  return <div className="space-y-3">
    <form action={action}>
      <input type="hidden" name="tokenId" value={token.id} />
      <input type="hidden" name="label" value={token.label} />
      <input type="hidden" name="prefix" value={token.prefix} />
      <button disabled={pending} className={secondaryButton}>{pending ? 'Replacing…' : 'Replace'}</button>
    </form>
    {state.message ? <p role="status">{state.message}</p> : null}
    {state.secret && state.prefix ? <SecretReveal secret={state.secret} prefix={state.prefix}>
      <p>Update your clients to use this secret, then revoke the old token.</p>
      <RevokeControl tokenId={state.oldTokenId ?? token.id} label={state.oldLabel || token.label} prefix={state.oldPrefix || token.prefix} offer="old" />
    </SecretReveal> : null}
  </div>;
}

export function GrantsControl({ token, projects }: { token: TokenView; projects: ProjectChoice[] }) {
  const [state, action, pending] = useActionState(setTokenGrantsAction, blankMessage);
  return <form action={action} className="space-y-3">
    <input type="hidden" name="tokenId" value={token.id} />
    <fieldset className="space-y-2">
      <legend className="font-medium">Project grants</legend>
      <p>The change applies on the agent&apos;s next request.</p>
      <ProjectChoices projects={projects} selected={new Set(token.projectIds)} />
    </fieldset>
    <button disabled={pending} className={secondaryButton}>{pending ? 'Saving grants…' : `Save grants for ${token.label}`}</button>
    {state.message ? <p role="status">{state.message}</p> : null}
  </form>;
}

export function TokenList({ tokens, projects }: { tokens: TokenView[]; projects: ProjectChoice[] }) {
  if (tokens.length === 0) return <p>No tokens yet. Create one to connect an agent.</p>;
  return <ul className="space-y-8">
    {tokens.map((token) => <li key={token.id} className="space-y-3 rounded border p-4">
      <h2 className="text-xl font-semibold">{token.label}</h2>
      <dl className="grid grid-cols-[10rem_1fr] gap-y-1">
        <dt>Prefix</dt><dd>{prefixLabel(token.prefix)}</dd>
        <dt>Scope</dt><dd>{token.scope === 'org' ? 'Broad' : 'Restricted'}</dd>
        <dt>Projects</dt><dd>{token.scope === 'org' ? 'All current and future projects' : token.projectNames.join(', ') || 'None'}</dd>
        <dt>Can create projects</dt><dd>{token.canCreateProjects ? 'Yes' : 'No'}</dd>
        <dt>Expiry</dt><dd>{formatWhen(token.expiresAt, 'No expiry')}</dd>
        <dt>Last used</dt><dd>{formatWhen(token.lastUsedAt, 'Never')}</dd>
        <dt>Revoked</dt><dd>{token.revokedAt ? `Revoked ${formatWhen(token.revokedAt, '')}` : 'Not revoked'}</dd>
      </dl>
      {token.revokedAt ? null : <div className="flex flex-wrap gap-6">
        <RevokeControl tokenId={token.id} label={token.label} prefix={token.prefix} />
        <ReplaceControl token={token} />
      </div>}
      {!token.revokedAt && token.scope === 'projects' ? <GrantsControl token={token} projects={projects} /> : null}
    </li>)}
  </ul>;
}
