'use server';

import { revalidatePath } from 'next/cache';
import { createMemberInvite, removeMember, revokeMemberInvite, setMemberCanCreateProjects } from '../../../../domain/members';
import { loadEnv } from '../../../../env';
import { actionFailure, requireOrgOwnerPage } from '../../session';

export type InviteFormState = {
  message?: string;
  link?: string;
  expiresAt?: string;
};

export async function inviteMemberAction(_state: InviteFormState, data: FormData): Promise<InviteFormState> {
  const principal = await requireOrgOwnerPage();
  try {
    const result = await createMemberInvite(principal, {
      email: String(data.get('email') ?? ''),
      canCreateProjects: data.get('canCreateProjects') === 'on',
    });
    revalidatePath('/settings/members');
    return {
      link: new URL(`/join/${result.token}`, loadEnv().APP_BASE_URL).toString(),
      expiresAt: result.expiresAt.toISOString(),
      message: 'Invite created. Copy the link now — it will not be shown again.',
    };
  } catch (error) {
    const failure = actionFailure(error);
    return { message: failure.message };
  }
}

export async function revokeInviteAction(inviteId: string) {
  const principal = await requireOrgOwnerPage();
  try {
    await revokeMemberInvite(principal, inviteId);
  } catch (error) {
    actionFailure(error);
  }
  revalidatePath('/settings/members');
}

export async function setCanCreateProjectsAction(memberId: string, enabled: boolean) {
  const principal = await requireOrgOwnerPage();
  try {
    await setMemberCanCreateProjects(principal, memberId, enabled);
  } catch (error) {
    actionFailure(error);
  }
  revalidatePath('/settings/members');
}

export async function removeMemberAction(memberId: string) {
  const principal = await requireOrgOwnerPage();
  try {
    await removeMember(principal, memberId);
  } catch (error) {
    actionFailure(error);
  }
  revalidatePath('/settings/members');
}
