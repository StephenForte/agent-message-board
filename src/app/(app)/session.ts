import { notFound, redirect } from 'next/navigation';
import { requireHuman } from '../../auth/web';
import type { HumanPrincipal } from '../../domain/kernel';
import { humanLanding } from '../../domain/organizations';
import { domainFailure, type DomainFailure } from './domain-message';

/** Active owner. No-org and suspended sessions go to the T03 pages. */
export async function ownerPrincipal(): Promise<HumanPrincipal> {
  const principal = await requireHuman();
  const landing = await humanLanding(principal);
  if (landing !== '/') redirect(landing);
  return principal;
}

export function raiseDomain(error: unknown): never {
  const failure = domainFailure(error);
  if (failure.notFound) notFound();
  if (failure.redirect) redirect(failure.redirect);
  throw new Error('The page could not be loaded.');
}

export function actionFailure(error: unknown): DomainFailure {
  const failure = domainFailure(error);
  if (failure.notFound) notFound();
  if (failure.redirect) redirect(failure.redirect);
  return failure;
}
