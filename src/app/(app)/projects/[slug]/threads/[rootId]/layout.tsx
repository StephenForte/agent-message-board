import { notFound } from 'next/navigation';
import { DomainError } from '../../../../../../domain/kernel';
import { getThread } from '../../../../../../domain/messages';
import { loadHumanProject } from '../../load-project';

export default async function ThreadLayout({ children, params }: {
  children: React.ReactNode;
  params: Promise<{ slug: string; rootId: string }>;
}) {
  const { slug, rootId } = await params;
  const { principal, project } = await loadHumanProject(slug);
  try {
    const thread = await getThread(principal, { rootId, replyLimit: 1 });
    if (thread.project.slug !== project.slug) notFound();
  } catch (error) {
    if (error instanceof DomainError && (error.code === 'forbidden_or_not_found' || error.code === 'validation_failed')) notFound();
    throw error;
  }
  return children;
}
