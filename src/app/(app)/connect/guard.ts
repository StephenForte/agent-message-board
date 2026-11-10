import { notFound, redirect, unstable_rethrow } from 'next/navigation';
import { requireHuman } from '../../../auth/web';
import { humanLanding } from '../../../domain/organizations';
import { DomainError } from '../../../domain/kernel';
export async function connectionOwner() {
  const principal = await requireHuman();
  const landing = await humanLanding(principal);
  if (landing !== '/') redirect(landing);
  return principal;
}
export function connectionFailure(error: unknown): { message: string } {
  unstable_rethrow(error);
  if (error instanceof DomainError && error.code === 'forbidden_or_not_found') notFound();
  if (error instanceof DomainError && error.code === 'org_suspended') redirect('/suspended');
  if (error instanceof DomainError && error.code === 'validation_failed') return { message: 'Check the name, expiry, and selected projects. Restricted defaults must be within the token scope.' };
  return { message: 'Connection setup is unavailable. Please refresh and try again.' };
}
