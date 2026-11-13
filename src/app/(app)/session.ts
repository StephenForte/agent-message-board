import { notFound, redirect } from 'next/navigation';
import { requireHuman } from '../../auth/web';
import { withOrgTx, type HumanPrincipal } from '../../domain/kernel';
import { humanLanding } from '../../domain/organizations';
import { domainFailure, type DomainFailure } from './domain-message';

/** Active org human (owner or member). No-org and suspended sessions go to the T03 pages. */
export async function ownerPrincipal(): Promise<HumanPrincipal> {
  const principal = await requireHuman();
  const landing = await humanLanding(principal);
  if (landing !== '/') redirect(landing);
  return principal;
}

/** Owner-only pages. Members receive the same 404 as missing routes. */
export async function requireOrgOwnerPage(): Promise<HumanPrincipal> {
  const principal = await ownerPrincipal();
  // Re-read role in the org transaction — never trust the session hint alone.
  try {
    const role = await withOrgTx(principal, async (_tx, ctx) => ctx.role);
    if (role !== 'owner') notFound();
  } catch {
    notFound();
  }
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
