import { notFound, redirect } from 'next/navigation';
import { requireHuman } from '../../../../auth/web';
import { DomainError, type HumanPrincipal } from '../../../../domain/kernel';
import { humanLanding } from '../../../../domain/organizations';
import { getProjectBySlug } from '../../../../domain/projects';

export async function loadHumanProject(slug: string): Promise<{
  principal: HumanPrincipal;
  project: Awaited<ReturnType<typeof getProjectBySlug>>;
}> {
  const principal = await requireHuman();
  const landing = await humanLanding(principal);
  if (landing !== '/') redirect(landing);
  try {
    const project = await getProjectBySlug(principal, slug);
    return { principal, project };
  } catch (error) {
    if (error instanceof DomainError && error.code === 'forbidden_or_not_found') notFound();
    if (error instanceof DomainError && error.code === 'org_suspended') redirect('/suspended');
    throw error;
  }
}
