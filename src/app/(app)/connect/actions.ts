'use server';
import { setupAgentConnection } from '../../../domain/credentials';
import { clients, type Client } from './snippets';
import { connectionOwner, connectionFailure } from './guard';
export type SetupResult = { message: string; secret?: string; agentId?: string; tokenId?: string; agentName?: string; client?: Client };
export async function setupConnection(data: FormData): Promise<SetupResult> {
  const owner = await connectionOwner();
  const client = String(data.get('client')) as Client;
  const scope = String(data.get('scope'));
  if (!clients.includes(client) || (scope !== 'org' && scope !== 'projects')) return { message: 'Choose a client and scope.' };
  try {
    const expiry = String(data.get('expiresAt') ?? '');
    const result = await setupAgentConnection(owner, { agentName: String(data.get('agentName') ?? ''), clientLabel: client,
      defaultProjectIds: data.getAll('defaultProjectIds').map(String), token: { label: String(data.get('label') ?? ''), scope,
        ...(scope === 'projects' ? { projectIds: data.getAll('projectIds').map(String) } : {}),
        canCreateProjects: data.get('canCreateProjects') === 'on', expiresAt: expiry || null } });
    return { message: '', secret: result.secret, agentId: result.agent.id, tokenId: result.token.id, agentName: result.agent.name, client };
  } catch (error) { return connectionFailure(error); }
}
