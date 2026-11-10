import { connectionOwner, connectionFailure } from '../../guard';
import { getConnectionDiagnostics } from '../../../../../domain/credentials';
export const dynamic = 'force-dynamic';
export default async function DiagnosticsPage({ params }: { params: Promise<{ agentId: string; tokenId: string }> }) {
  const owner = await connectionOwner();
  const ids = await params;
  let result;
  let failure;
  try { result = await getConnectionDiagnostics(owner, ids); } catch (error) { failure = connectionFailure(error); }
  if (failure || !result) return <p role="alert">{failure?.message}</p>;
    return <main className="space-y-4"><h1 className="text-2xl font-semibold">Connection diagnostics</h1>
      <p>Organization: {result.org.name}</p><p>Agent: {result.agent.name} · {result.agent.id}</p>
      <p>Token: {result.token.label} · {result.tokenStatus}</p>
      <a className="underline" href={`/connect/${ids.agentId}/${ids.tokenId}`}>Refresh diagnostics</a>
      {result.sessions.length ? <section><h2 className="text-xl font-semibold">Recorded sessions</h2><ul>{result.sessions.map((s) => <li key={s.id}>{s.clientLabel ?? 'Unlabeled client'} · last seen {s.lastSeenAt} · session {s.id}</li>)}</ul></section> : <section><p>Waiting for the agent&apos;s first connect_agent</p><p>Check the Authorization bearer header, the server URL, and whether the token was copied correctly. Then ask the agent to call connect_agent and refresh.</p></section>}
      <section><h2 className="text-xl font-semibold">Effective projects</h2>{result.projects.length ? <ul>{result.projects.map((p) => <li key={p.id}>{p.name} · {p.access}</li>)}</ul> : <p>None</p>}</section>
      <section><h2 className="text-xl font-semibold">Effective defaults</h2>{result.defaults.length ? <ul>{result.defaults.map((p) => <li key={p.id}>{p.name}</li>)}</ul> : <p>None</p>}</section>
      <p>Can create projects: {result.capabilities.canCreateProjects ? 'Yes' : 'No'}</p><p>Last seen records contact, not whether an agent is running.</p>
    </main>;
}
