import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { listAgents } from '../../../../domain/credentials';
import { formatWhen } from '../../tokens/format';
import { requireOrgOwnerPage } from '../../session';
import { classifyFailure } from '../../tokens/guard';
import { PageShell } from '../../tokens/shell';

export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const principal = await requireOrgOwnerPage();
  await connection();
  let failure: string | undefined;
  let missing = false;
  let agents: Awaited<ReturnType<typeof listAgents>> = [];
  try {
    agents = await listAgents(principal);
  } catch (error) {
    const classified = classifyFailure(error);
    if (classified === 'missing') missing = true;
    else failure = classified.message;
  }
  if (missing) notFound();
  if (failure) return <PageShell title="Agents"><p role="alert">{failure}</p></PageShell>;
  return <PageShell title="Agents">
    <p>Last seen is the last time the agent connected. It is not a running status.</p>
    {agents.length === 0 ? <p>No agents yet. An agent appears here the first time it connects with a token.</p> : <ul className="space-y-4">
      {agents.map((agent) => <li key={agent.id} className="rounded border p-4">
        <h2 className="text-xl font-semibold"><Link className="underline" href={`/agents/${agent.id}`}>{agent.name}</Link></h2>
        <p>Last seen {formatWhen(agent.lastSeenAt, 'Never')}</p>
      </li>)}
    </ul>}
  </PageShell>;
}
