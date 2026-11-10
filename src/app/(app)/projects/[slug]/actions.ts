'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireHuman } from '../../../../auth/web';
import { DomainError } from '../../../../domain/kernel';
import { getThread, postReply, postRoot } from '../../../../domain/messages';
import { humanLanding } from '../../../../domain/organizations';
import { getProjectBySlug } from '../../../../domain/projects';
import { type Category, categories, type ComposerResult, projectPath, threadPath } from './composer-model';
import { domainMessage } from './domain-message';

async function gate() {
  const principal = await requireHuman();
  const landing = await humanLanding(principal);
  if (landing !== '/') redirect(landing);
  return principal;
}

function failure(error: unknown, idempotencyKey: string): ComposerResult {
  if (error instanceof DomainError) return { ok: false, message: domainMessage(error), idempotencyKey };
  throw error;
}

export async function postRootAction(slug: string, formData: FormData): Promise<ComposerResult> {
  const principal = await gate();
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '');
  const category = String(formData.get('category') ?? 'note');
  if (!(categories as readonly string[]).includes(category)) {
    return { ok: false, message: domainMessage(new DomainError('validation_failed')), idempotencyKey };
  }
  let created: { id: string };
  try {
    const project = await getProjectBySlug(principal, slug);
    if (project.status === 'archived') {
      return { ok: false, message: domainMessage(new DomainError('project_archived')), idempotencyKey };
    }
    created = await postRoot(principal, {
      projectId: project.id,
      title: String(formData.get('title') ?? ''),
      body: String(formData.get('body') ?? ''),
      category: category as Category,
      recipients: formData.getAll('recipient').map(String),
      urgent: formData.get('urgent') === 'true',
      pinned: formData.get('pinned') === 'true',
      idempotencyKey,
    });
  } catch (error) {
    return failure(error, idempotencyKey);
  }
  revalidatePath(projectPath(slug));
  redirect(threadPath(slug, created.id));
}

export async function postReplyAction(slug: string, rootId: string, formData: FormData): Promise<ComposerResult> {
  const principal = await gate();
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '');
  try {
    const project = await getProjectBySlug(principal, slug);
    if (project.status === 'archived') {
      return { ok: false, message: domainMessage(new DomainError('project_archived')), idempotencyKey };
    }
    const thread = await getThread(principal, { rootId, replyLimit: 1 });
    if (thread.project.slug !== project.slug) {
      return { ok: false, message: domainMessage(new DomainError('forbidden_or_not_found')), idempotencyKey };
    }
    await postReply(principal, {
      rootId,
      body: String(formData.get('body') ?? ''),
      recipients: formData.getAll('recipient').map(String),
      idempotencyKey,
    });
  } catch (error) {
    return failure(error, idempotencyKey);
  }
  revalidatePath(threadPath(slug, rootId));
  redirect(threadPath(slug, rootId));
}
