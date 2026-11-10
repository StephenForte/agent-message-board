'use server';

import { revalidatePath } from 'next/cache';
import { clearOrgAnnouncement, setOrgAnnouncement } from '../../../domain/announcements';
import { actionFailure, ownerPrincipal } from '../session';
import type { AnnouncementFormState } from './announcement-state';

export async function saveOrgAnnouncement(_state: AnnouncementFormState, data: FormData): Promise<AnnouncementFormState> {
  const principal = await ownerPrincipal();
  const title = String(data.get('title') ?? '');
  const body = String(data.get('body') ?? '');
  const expectedVersion = versionOf(data);
  try {
    const saved = await setOrgAnnouncement(principal, { title, body, expectedVersion });
    revalidatePath('/settings');
    revalidatePath('/');
    revalidatePath('/settings/audit');
    return { message: 'Announcement saved.', version: saved.version };
  } catch (error) {
    return announcementError(error, title, body);
  }
}

export async function clearOrgAnnouncementAction(_state: AnnouncementFormState, data: FormData): Promise<AnnouncementFormState> {
  const principal = await ownerPrincipal();
  try {
    const cleared = await clearOrgAnnouncement(principal, { expectedVersion: versionOf(data) });
    revalidatePath('/settings');
    revalidatePath('/');
    revalidatePath('/settings/audit');
    return { message: 'Announcement cleared.', version: cleared.version, cleared: true };
  } catch (error) {
    return announcementError(error);
  }
}

function versionOf(data: FormData): number {
  const raw = String(data.get('expectedVersion') ?? '');
  return /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
}

function announcementError(error: unknown, title?: string, body?: string): AnnouncementFormState {
  const failure = actionFailure(error);
  if (failure.conflict) {
    revalidatePath('/settings');
    revalidatePath('/');
    revalidatePath('/settings/audit');
  }
  return {
    message: failure.message,
    field: failure.field,
    conflict: failure.conflict,
    version: failure.conflict?.currentVersion,
    draftTitle: title,
    draftBody: body,
  };
}
