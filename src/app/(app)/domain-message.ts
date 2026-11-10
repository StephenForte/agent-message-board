import { DomainError, type DomainErrorCode } from '../../domain/kernel';

export type AnnouncementConflict = {
  currentVersion: number;
  stateLabel: string;
};

export type DomainFailure = {
  message: string;
  field?: string;
  notFound?: boolean;
  redirect?: '/suspended';
  conflict?: AnnouncementConflict;
};

export function domainFailure(error: unknown): DomainFailure {
  if (!(error instanceof DomainError)) return { message: 'The page could not be loaded. Try again.' };
  if (error.code === 'forbidden_or_not_found') return { message: 'That page is not available.', notFound: true };
  if (error.code === 'org_suspended') return { message: 'This organization is suspended.', redirect: '/suspended' };
  if (error.code === 'version_conflict') return conflictFailure(error.details.currentVersion, error.details.state);
  const field = typeof error.details.field === 'string' ? error.details.field : undefined;
  return { message: messageFor(error.code, field), field: error.code === 'validation_failed' ? field : undefined };
}

function conflictFailure(currentVersion: unknown, state: unknown): DomainFailure {
  const stateLabel = state === 'active' ? 'published' : state === 'cleared' ? 'cleared' : 'not published';
  if (typeof currentVersion !== 'number') {
    return { message: 'This announcement was updated. Reload and review the current version. Your draft is still in the form.' };
  }
  return {
    message: `This announcement was updated. Current version is ${currentVersion} (${stateLabel}). Your draft is still in the form.`,
    conflict: { currentVersion, stateLabel },
  };
}

function messageFor(code: DomainErrorCode, field: string | undefined): string {
  if (code === 'validation_failed') return fieldMessage(field);
  if (code === 'content_too_large') return 'Title and body must each be 16 KiB or smaller.';
  if (code === 'unavailable') return 'The board is temporarily unavailable. Nothing was saved. Try again.';
  if (code === 'idempotency_conflict') return 'This form was already submitted with different values. Reload the page and try again.';
  if (code === 'capability_denied') return 'You cannot do that.';
  if (code === 'rate_limited') return 'Too many requests. Wait a moment and try again.';
  if (code === 'invalid_cursor') return 'This audit page link is out of date. Start again from the newest records.';
  return 'The request could not be completed. Try again.';
}

export function fieldMessage(field: string | undefined): string {
  if (field === 'slug') return 'Use lowercase letters, numbers, and hyphens. Start with a letter or number, up to 63 characters.';
  if (field === 'name') return 'Enter a name up to 200 characters.';
  if (field === 'description') return 'Description must be 8 KiB or smaller.';
  if (field === 'title') return 'Enter a title.';
  if (field === 'body') return 'The body is not valid.';
  if (field === 'expectedVersion') return 'Reload the page and try again.';
  return 'Check the form and try again.';
}
