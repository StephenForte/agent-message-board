'use client';
import Link from 'next/link';
import { useActionState, useEffect, useState } from 'react';
import { setupConnection, type SetupResult } from './actions';
import { clients, clientSetup, consulted } from './snippets';
function expiryIso(value: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}
export function Wizard({ projects, mcpUrl }: { projects: { id: string; name: string }[]; mcpUrl: string }) {
  const [state, setState] = useState<SetupResult>({ message: '' });

  const [scope, setScope] = useState('projects');
  const [canCreate, setCanCreate] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expiry, setExpiry] = useState('');
  // Clear credentials when a page is restored from the browser's back/forward cache.
  useEffect(() => {
    const clear = () => setState({ message: '' });
    const leaving = (event: MouseEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (anchor instanceof HTMLAnchorElement && (!anchor.target || anchor.target === '_self') && anchor.href !== window.location.href) clear();
    };
    window.addEventListener('pagehide', clear);
    window.addEventListener('pageshow', clear);
    window.addEventListener('popstate', clear);
    document.addEventListener('click', leaving, true);
    return () => {
      window.removeEventListener('pagehide', clear);
      window.removeEventListener('pageshow', clear);
      window.removeEventListener('popstate', clear);
      document.removeEventListener('click', leaving, true);
    };
  }, []);
  // Previous secret state stays in the browser: only FormData crosses the action boundary.
  const [, submit, pending] = useActionState(async (_previous: null, data: FormData) => {
    setState(await setupConnection(data));
    return null;
  }, null);
  if (state.secret && state.agentId && state.tokenId && state.client && state.agentName) {
    const setup = clientSetup(state.client, mcpUrl, state.agentName);
    return <section className="space-y-4" aria-label="Connection setup">
      <p role="alert">Copy this secret now. Reloading or leaving this page hides it permanently.</p>
      <label className="block">Token secret<input className="block w-full rounded border p-2 font-mono" readOnly autoComplete="off" spellCheck={false} value={state.secret} /></label>
      <button type="button" className="underline" onClick={() => { void navigator.clipboard.writeText(state.secret!).then(() => setCopied(true), () => setCopied(false)); }}>{copied ? 'Copied' : 'Copy secret'}</button>
      <h2 className="text-xl font-semibold">Set up {state.client}</h2>
      <ol className="list-decimal space-y-2 pl-6">{setup.steps.map((step) => <li key={step}>{step}</li>)}</ol>
      <pre className="overflow-auto whitespace-pre-wrap rounded border p-3">{setup.snippet}</pre>
      <h2 className="text-xl font-semibold">Instructions for {setup.rule}</h2>
      <pre className="whitespace-pre-wrap rounded border p-3">{setup.namedInstructions}</pre>
      <p><a className="underline" href={setup.source} target="_blank" rel="noreferrer">Official client documentation</a> · consulted {consulted} · real-client setup untested until T16.</p>
      <Link className="underline" href={`/connect/${state.agentId}/${state.tokenId}`}>Open connection diagnostics</Link>
    </section>;
  }
  return <form action={submit} className="space-y-4">
    <label className="block">Client<select name="client" className="ml-2 rounded border p-2">{clients.map((client) => <option key={client}>{client}</option>)}</select></label>
    <label className="block">Agent name<input className="ml-2 rounded border p-2" name="agentName" required pattern="[A-Za-z0-9._\-]{1,64}" maxLength={64} /></label>
    <label className="block">Token label<input className="ml-2 rounded border p-2" name="label" required maxLength={200} /></label>
    <fieldset><legend>Token scope</legend>
      <label className="block"><input type="radio" name="scope" value="org" checked={scope === 'org'} onChange={() => { setScope('org'); setCanCreate(true); }} /> Broad: all current and future organization projects.</label>
      <label className="block"><input type="radio" name="scope" value="projects" checked={scope === 'projects'} onChange={() => { setScope('projects'); setCanCreate(false); }} /> Restricted: only selected projects; new projects need an explicit grant.</label>
    </fieldset>
    <fieldset><legend>Default projects</legend><p>Defaults guide board checks and never widen access. Choose defaults within the restricted token scope.</p>{projects.length ? projects.map((p) => <label className="block" key={p.id}><input type="checkbox" name="defaultProjectIds" value={p.id} /> {p.name}</label>) : <p>No projects yet. Create a project first, or allow the agent to create one.</p>}</fieldset>
    {scope === 'projects' ? <fieldset><legend>Token project access</legend>{projects.map((p) => <label className="block" key={p.id}><input type="checkbox" name="projectIds" value={p.id} /> {p.name}</label>)}</fieldset> : null}
    <label className="block"><input type="checkbox" name="canCreateProjects" checked={canCreate} onChange={(event) => setCanCreate(event.target.checked)} /> Can create projects</label>
    <label className="block">Expiry (optional, local time)<input className="ml-2 rounded border p-2" type="datetime-local" value={expiry} onChange={(event) => setExpiry(event.target.value)} /></label>
    <input type="hidden" name="expiresAt" value={expiryIso(expiry)} />
    <button className="rounded border px-4 py-2" disabled={pending}>{pending ? 'Setting up…' : 'Create connection'}</button>
    {state.message ? <p role="alert">{state.message}</p> : null}
  </form>;
}
