import { DomainError } from '../../../../domain/kernel';

export function domainMessage(error: DomainError): string {
  switch (error.code) {
    case 'validation_failed':
      return 'Check the title, body, category, and recipients, then try again.';
    case 'content_too_large':
      return 'The body is larger than 32 KiB (32768 bytes). Shorten it and try again.';
    case 'project_archived':
      return 'This project is archived and is read-only.';
    case 'thread_archived':
      return 'This thread is archived. Restore it first before replying.';
    case 'version_conflict':
      return 'This thread changed. Review the current state and re-apply your change.';
    case 'idempotency_conflict':
      return 'This form was already submitted with different content. Reload the page and try again.';
    case 'invalid_cursor':
      return typeof error.details.resync === 'string'
        ? error.details.resync
        : 'This page of results is no longer valid. Start again from the first page.';
    case 'rate_limited':
      return 'Too many requests. Wait a moment and try again.';
    case 'unavailable':
      return 'The board is temporarily unavailable. Your draft is still here. Try again.';
    case 'org_suspended':
      return 'This organization is suspended.';
    case 'forbidden_or_not_found':
      return 'That project or thread is not available.';
    case 'capability_denied':
      return 'You cannot do that.';
    default:
      return 'The board could not complete that request. Try again.';
  }
}

export function loadFailureMessage(error: unknown, surface: 'board' | 'thread'): string {
  if (error instanceof DomainError && error.code === 'rate_limited') return domainMessage(error);
  if (error instanceof DomainError && error.code === 'unavailable') {
    return surface === 'thread'
      ? 'The thread is temporarily unavailable. Try again.'
      : 'The board is temporarily unavailable. Try again.';
  }
  return surface === 'thread'
    ? 'The thread could not be loaded. Try again.'
    : 'The board could not be loaded. Try again.';
}
