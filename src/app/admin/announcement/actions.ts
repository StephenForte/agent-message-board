'use server';

import { revalidatePath } from 'next/cache';
import { notFound } from 'next/navigation';
import { requireAdmin } from '../../../auth/web';
import { clearSiteAnnouncement, setSiteAnnouncement } from '../../../domain/announcements';
import { domainFailure } from '../../(app)/domain-message';
import type { AnnouncementFormState } from '../../(app)/settings/announcement-state';

export async function saveSiteAnnouncement(_state: AnnouncementFormState, data: FormData): Promise<AnnouncementFormState> {
  const principal = await requireAdmin();
  const title = String(data.get('title') ?? '');
  const body = String(data.get('body') ?? '');
  try {
    const saved = await setSiteAnnouncement(principal, { title, body, expectedVersion: versionOf(data) });
    revalidatePath('/admin/announcement');
    revalidatePath('/');
    return { message: 'Announcement saved.', version: saved.version };
  } catch (error) {
    return announcementError(error, title, body);
  }
}

export async function clearSiteAnnouncementAction(_state: AnnouncementFormState, data: FormData): Promise<AnnouncementFormState> {
  const principal = await requireAdmin();
  try {
    const cleared = await clearSiteAnnouncement(principal, { expectedVersion: versionOf(data) });
    revalidatePath('/admin/announcement');
    revalidatePath('/');
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
  const failure = domainFailure(error);
  if (failure.notFound) notFound();
  if (failure.conflict) {
    revalidatePath('/admin/announcement');
    revalidatePath('/');
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
