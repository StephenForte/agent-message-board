import { notFound, redirect, unstable_rethrow } from 'next/navigation';
import { requireHuman } from '../../../auth/web';
import { DomainError, type HumanPrincipal } from '../../../domain/kernel';
import { humanLanding } from '../../../domain/organizations';
import { plainDomainMessage } from './messages';

export async function requireOwner(): Promise<HumanPrincipal> {
  const principal = await requireHuman();
  const landing = await humanLanding(principal);
  if (landing !== '/') redirect(landing);
  if (!principal.orgId) redirect('/no-organization');
  return principal;
}

/** Page reads: unknown tenants are missing. Driver errors stay off the screen. */
export function classifyFailure(error: unknown): 'missing' | { message: string } {
  unstable_rethrow(error);
  if (error instanceof DomainError && error.code === 'forbidden_or_not_found') return 'missing';
  if (error instanceof DomainError && error.code === 'org_suspended') redirect('/suspended');
  if (error instanceof DomainError) return { message: plainDomainMessage(error) };
  throw new Error('This page is unavailable. Please try again.');
}

/** Mutations: a missing token or agent is a 404. Never return a driver message. */
export function actionFailure(error: unknown): { message: string } {
  const classified = classifyFailure(error);
  if (classified === 'missing') notFound();
  return classified;
}
