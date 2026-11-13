import { Suspense } from 'react';
import { connection } from 'next/server';
import { notFound } from 'next/navigation';
import { getAgentDefaults, listAgentSessions, listAgents } from '../../../../domain/credentials';
import { listProjects } from '../../../../domain/projects';
import { formatWhen, prefixLabel } from '../../tokens/format';
import { requireOrgOwnerPage } from '../../session';
import { classifyFailure } from '../../tokens/guard';
import { PageShell } from '../../tokens/shell';
import { DefaultsForm } from './forms';

export const dynamic = 'force-dynamic';

export default async function AgentPage({ params }: { params: Promise<{ agentId: string }> }) {
  await connection();
  const { agentId } = await params;
  const principal = await requireOrgOwnerPage();
  let failure: string | undefined;
  let missing = false;
  let agent: { id: string; name: string; lastSeenAt: string | null } | undefined;
  try {
    const found = (await listAgents(principal)).find((item) => item.id === agentId);
    if (!found) missing = true;
    else agent = { id: found.id, name: found.name, lastSeenAt: found.lastSeenAt };
  } catch (error) {
    const classified = classifyFailure(error);
    if (classified === 'missing') missing = true;
    else failure = classified.message;
  }
  if (missing) notFound();
  if (failure || !agent) return <PageShell title="Agent"><p role="alert">{failure ?? 'This page is unavailable. Try again.'}</p></PageShell>;
  return <Suspense fallback={<main className="mx-auto max-w-3xl p-8"><p role="status">Loading agent…</p></main>}>
    <AgentBody principal={principal} agent={agent} />
  </Suspense>;
}

async function AgentBody({
  principal,
  agent,
}: {
  principal: Parameters<typeof listAgentSessions>[0];
  agent: { id: string; name: string; lastSeenAt: string | null };
}) {
  let failure: string | undefined;
  let missing = false;
  let loaded: {
    sessions: Awaited<ReturnType<typeof listAgentSessions>>;
    projects: { id: string; name: string }[];
    selectedIds: string[];
  } | undefined;
  try {
    const [sessions, defaults, projects] = await Promise.all([
      listAgentSessions(principal, agent.id),
      getAgentDefaults(principal, agent.id),
      listProjects(principal),
    ]);
    loaded = {
      sessions,
      projects: projects.map((project) => ({ id: project.id, name: project.name })),
      selectedIds: defaults.map((project) => project.id),
    };
  } catch (error) {
    const classified = classifyFailure(error);
    if (classified === 'missing') missing = true;
    else failure = classified.message;
  }
  if (missing) notFound();
  if (failure || !loaded) return <PageShell title="Agent"><p role="alert">{failure ?? 'This page is unavailable. Try again.'}</p></PageShell>;
  return <PageShell title={agent.name}>
    <p>Last seen {formatWhen(agent.lastSeenAt, 'Never')}. Last seen is not a running status.</p>
    <section aria-label="Sessions" className="space-y-3">
      <h2 className="text-xl font-semibold">Sessions</h2>
      {loaded.sessions.length === 0 ? <p>No sessions yet.</p> : <table className="w-full border-collapse text-left">
        <thead><tr>
          <th className="border-b p-2">Token prefix</th>
          <th className="border-b p-2">Client label</th>
          <th className="border-b p-2">Created</th>
          <th className="border-b p-2">Last seen</th>
        </tr></thead>
        <tbody>
          {loaded.sessions.map((session) => <tr key={session.id}>
            <td className="border-b p-2">{prefixLabel(session.tokenPrefix)}</td>
            <td className="border-b p-2">{session.clientLabel ?? 'None'}</td>
            <td className="border-b p-2">{formatWhen(session.createdAt, 'Unknown')}</td>
            <td className="border-b p-2">{formatWhen(session.lastSeenAt, 'Never')}</td>
          </tr>)}
        </tbody>
      </table>}
    </section>
    <section aria-label="Default projects" className="space-y-3">
      <h2 className="text-xl font-semibold">Default projects</h2>
      <DefaultsForm agentId={agent.id} projects={loaded.projects} selectedIds={loaded.selectedIds} />
    </section>
  </PageShell>;
}
