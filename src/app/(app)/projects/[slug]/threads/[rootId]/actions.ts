'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireHuman } from '../../../../../../auth/web';
import { DomainError } from '../../../../../../domain/kernel';
import { getThread, updateRootFlags } from '../../../../../../domain/messages';
import { humanLanding } from '../../../../../../domain/organizations';
import { getProjectBySlug } from '../../../../../../domain/projects';
import { projectPath, threadPath } from '../../composer-model';
import { domainMessage } from '../../domain-message';

export type FlagIntent = { status?: 'active' | 'archived'; urgent?: boolean; pinned?: boolean };
export type FlagSnapshot = { status: 'active' | 'archived'; urgent: boolean; pinned: boolean; version: number };
export type FlagFormState = {
  alert: string | null;
  conflict: null | { current: FlagSnapshot; intent: FlagIntent; idempotencyKey: string };
};

async function gate() {
  const principal = await requireHuman();
  const landing = await humanLanding(principal);
  if (landing !== '/') redirect(landing);
  return principal;
}

function readIntent(formData: FormData): FlagIntent | null {
  const intent: FlagIntent = {};
  const status = formData.get('status');
  if (status === 'active' || status === 'archived') intent.status = status;
  else if (status !== null) return null;
  const urgent = formData.get('urgent');
  if (urgent === 'true') intent.urgent = true;
  else if (urgent === 'false') intent.urgent = false;
  else if (urgent !== null) return null;
  const pinned = formData.get('pinned');
  if (pinned === 'true') intent.pinned = true;
  else if (pinned === 'false') intent.pinned = false;
  else if (pinned !== null) return null;
  if (intent.status === undefined && intent.urgent === undefined && intent.pinned === undefined) return null;
  return intent;
}

function readConflict(error: DomainError): FlagSnapshot | null {
  const state = error.details.state;
  if (!state || typeof state !== 'object') return null;
  const record = state as Record<string, unknown>;
  if ((record.status !== 'active' && record.status !== 'archived') || typeof record.urgent !== 'boolean' || typeof record.pinned !== 'boolean') return null;
  const version = typeof record.version === 'number' ? record.version : error.details.currentVersion;
  if (typeof version !== 'number') return null;
  return { status: record.status, urgent: record.urgent, pinned: record.pinned, version };
}

export async function updateFlagsAction(slug: string, rootId: string, _previous: FlagFormState, formData: FormData): Promise<FlagFormState> {
  const principal = await gate();
  const idempotencyKey = String(formData.get('idempotencyKey') ?? '');
  const intent = readIntent(formData);
  const expectedVersion = Number(formData.get('expectedVersion'));
  if (!intent || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return { alert: domainMessage(new DomainError('validation_failed')), conflict: null };
  }
  try {
    const project = await getProjectBySlug(principal, slug);
    if (project.status === 'archived') return { alert: domainMessage(new DomainError('project_archived')), conflict: null };
    const thread = await getThread(principal, { rootId, replyLimit: 1 });
    if (thread.project.slug !== project.slug) return { alert: domainMessage(new DomainError('forbidden_or_not_found')), conflict: null };
    await updateRootFlags(principal, { rootId, expectedVersion, idempotencyKey, ...intent });
  } catch (error) {
    if (error instanceof DomainError && error.code === 'version_conflict') {
      const current = readConflict(error);
      if (!current) return { alert: domainMessage(error), conflict: null };
      return { alert: null, conflict: { current, intent, idempotencyKey: randomUUID() } };
    }
    if (error instanceof DomainError) return { alert: domainMessage(error), conflict: null };
    throw error;
  }
  revalidatePath(projectPath(slug));
  revalidatePath(threadPath(slug, rootId));
  redirect(threadPath(slug, rootId));
}
