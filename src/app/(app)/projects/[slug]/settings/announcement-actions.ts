'use server';

import { revalidatePath } from 'next/cache';
import { clearProjectAnnouncement, setProjectAnnouncement } from '../../../../../domain/announcements';
import { getProjectBySlug } from '../../../../../domain/projects';
import { actionFailure, ownerPrincipal } from '../../../session';
import type { AnnouncementFormState } from '../../../settings/announcement-state';

export async function saveProjectAnnouncement(slug: string, _state: AnnouncementFormState, data: FormData): Promise<AnnouncementFormState> {
  const principal = await ownerPrincipal();
  const title = String(data.get('title') ?? '');
  const body = String(data.get('body') ?? '');
  try {
    const project = await getProjectBySlug(principal, slug);
    const saved = await setProjectAnnouncement(principal, { projectId: project.id, title, body, expectedVersion: versionOf(data) });
    refresh(slug);
    return { message: 'Announcement saved.', version: saved.version };
  } catch (error) { return failure(error, slug, title, body); }
}

export async function clearProjectAnnouncementAction(slug: string, _state: AnnouncementFormState, data: FormData): Promise<AnnouncementFormState> {
  const principal = await ownerPrincipal();
  try {
    const project = await getProjectBySlug(principal, slug);
    const cleared = await clearProjectAnnouncement(principal, { projectId: project.id, expectedVersion: versionOf(data) });
    refresh(slug);
    return { message: 'Announcement cleared.', version: cleared.version, cleared: true };
  } catch (error) { return failure(error, slug); }
}

function versionOf(data: FormData): number {
  const raw = String(data.get('expectedVersion') ?? '');
  return /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
}

function refresh(slug: string) {
  revalidatePath(`/projects/${slug}/settings`);
  revalidatePath(`/projects/${slug}`);
  revalidatePath(`/projects/${slug}/briefing`);
  revalidatePath('/settings/audit');
}

function failure(error: unknown, slug: string, title?: string, body?: string): AnnouncementFormState {
  const result = actionFailure(error);
  if (result.conflict) refresh(slug);
  return { message: result.message, field: result.field, conflict: result.conflict,
    version: result.conflict?.currentVersion, draftTitle: title, draftBody: body };
}
