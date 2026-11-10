import { notFound, unstable_rethrow } from 'next/navigation';
import { DomainError } from '../../../../../../domain/kernel';
import { getThread } from '../../../../../../domain/messages';
import { loadFailureMessage } from '../../domain-message';
import { loadHumanProject } from '../../load-project';
import { RetryPanel } from '../../retry-panel';

async function loadThreadGate(slug: string, rootId: string) {
  try {
    const { principal, project } = await loadHumanProject(slug);
    const thread = await getThread(principal, { rootId, replyLimit: 1 });
    if (thread.project.slug !== project.slug) notFound();
    return { ok: true as const };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof DomainError && (error.code === 'forbidden_or_not_found' || error.code === 'validation_failed')) notFound();
    return { ok: false as const, message: loadFailureMessage(error, 'thread') };
  }
}

export default async function ThreadLayout({ children, params }: {
  children: React.ReactNode;
  params: Promise<{ slug: string; rootId: string }>;
}) {
  const { slug, rootId } = await params;
  const gate = await loadThreadGate(slug, rootId);
  if (!gate.ok) return <RetryPanel message={gate.message} />;
  return children;
}
