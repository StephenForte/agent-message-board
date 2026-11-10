'use server';

import { revalidatePath } from 'next/cache';
import { createToken, replaceToken, revokeToken, setTokenGrants } from '../../../domain/credentials';
import { actionFailure, requireOwner } from './guard';

export type MessageState = { message: string };

export type SecretState = MessageState & {
  secret?: string;
  prefix?: string;
  oldTokenId?: string;
  oldLabel?: string;
  oldPrefix?: string;
};

const text = (data: FormData, key: string) => String(data.get(key) ?? '');

function scopeOf(value: string): 'org' | 'projects' | null {
  if (value === 'org' || value === 'projects') return value;
  return null;
}

export async function createTokenAction(_state: SecretState, data: FormData): Promise<SecretState> {
  const principal = await requireOwner();
  const scope = scopeOf(text(data, 'scope'));
  if (!scope) return { message: 'Choose broad or restricted access.' };
  const expiresAt = text(data, 'expiresAt');
  try {
    const result = await createToken(principal, {
      label: text(data, 'label'),
      scope,
      ...(scope === 'projects' ? { projectIds: data.getAll('projectIds').map(String) } : {}),
      canCreateProjects: data.get('canCreateProjects') === 'true',
      expiresAt: expiresAt ? expiresAt : null,
    });
    // The secret exists only in this result. Do not redirect, revalidate, log, or store it.
    return { message: '', secret: result.secret, prefix: result.token.prefix };
  } catch (error) {
    return actionFailure(error);
  }
}

export async function replaceTokenAction(_state: SecretState, data: FormData): Promise<SecretState> {
  const principal = await requireOwner();
  const tokenId = text(data, 'tokenId');
  try {
    const result = await replaceToken(principal, tokenId);
    // The secret exists only in this result. Do not redirect, revalidate, log, or store it.
    return {
      message: '',
      secret: result.secret,
      prefix: result.token.prefix,
      oldTokenId: tokenId,
      oldLabel: text(data, 'label'),
      oldPrefix: text(data, 'prefix'),
    };
  } catch (error) {
    return actionFailure(error);
  }
}

export async function revokeTokenAction(_state: MessageState, data: FormData): Promise<MessageState> {
  const principal = await requireOwner();
  try {
    await revokeToken(principal, text(data, 'tokenId'));
    revalidatePath('/tokens');
    return { message: 'Token revoked.' };
  } catch (error) {
    return actionFailure(error);
  }
}

export async function setTokenGrantsAction(_state: MessageState, data: FormData): Promise<MessageState> {
  const principal = await requireOwner();
  try {
    await setTokenGrants(principal, text(data, 'tokenId'), data.getAll('projectIds').map(String));
    revalidatePath('/tokens');
    return { message: 'Grants saved. The change applies on the agent\'s next request.' };
  } catch (error) {
    return actionFailure(error);
  }
}
