'use server';

import { revalidatePath } from 'next/cache';
import { setAgentDefaults } from '../../../../domain/credentials';
import { actionFailure, requireOwner } from '../../tokens/guard';

export type MessageState = { message: string };

export async function setAgentDefaultsAction(_state: MessageState, data: FormData): Promise<MessageState> {
  const principal = await requireOwner();
  const agentId = String(data.get('agentId') ?? '');
  try {
    await setAgentDefaults(principal, agentId, data.getAll('projectIds').map(String));
    revalidatePath('/agents');
    revalidatePath(`/agents/${agentId}`);
    return { message: 'Defaults saved.' };
  } catch (error) {
    return actionFailure(error);
  }
}
