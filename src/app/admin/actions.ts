'use server';
import { revalidatePath } from 'next/cache';
import { requireAdmin } from '../../auth/web';
import { associateOwner, provisionOrganization, issueOwnerActivation, suspendOrganization, restoreOrganization } from '../../domain/organizations';
import { DomainError } from '../../domain/kernel';
import { loadEnv } from '../../env';
export type AdminResult = { message: string; activationUrl?: string };
export async function mutateOrganization(_state: AdminResult, data: FormData): Promise<AdminResult> {
  const principal = await requireAdmin();
  const value = (key: string) => String(data.get(key) ?? '');
  try {
    switch (value('operation')) {
      case 'create': await provisionOrganization(principal, { name: value('name'), ownerEmail: value('email') || undefined }); break;
      case 'associate': await associateOwner(principal, value('id'), value('email')); break;
      case 'activate': {
        const issued = await issueOwnerActivation(principal, value('id'), value('email'));
        revalidatePath('/admin');
        return { message: 'Copy this activation link now. It expires in 72 hours and will not be displayed again.',
          activationUrl: new URL(`/activate/${issued.token}`, loadEnv().APP_BASE_URL).toString() };
      }
      case 'suspend': await suspendOrganization(principal, value('id')); break;
      case 'restore': await restoreOrganization(principal, value('id')); break;
      default: return { message: 'Unknown operation.' };
    }
    revalidatePath('/admin');
    return { message: 'Organization updated.' };
  } catch (error) {
    if (error instanceof DomainError && error.code === 'forbidden_or_not_found') {
      // A revoked role gets the same server-side 404 as any other non-admin.
      await requireAdmin();
      return { message: 'Organization unavailable.' };
    }
    if (error instanceof DomainError && error.code === 'validation_failed') return { message: String(error.details.reason ?? 'Check your input.') };
    throw new Error('Organization update unavailable. Please try again.');
  }
}
