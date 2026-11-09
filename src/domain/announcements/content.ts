import { DomainError } from '../kernel/errors';

/** PRD §8: title and body each at most 16 KiB, measured as UTF-8 bytes. */
export const MAX_ANNOUNCEMENT_BYTES = 16_384;

/** PRD §10 default list size. */
export const DEFAULT_REVISION_LIMIT = 20;

/** PRD §10 maximum page size. */
export const MAX_REVISION_LIMIT = 100;

export type AnnouncementScope = 'site' | 'org';

/**
 * Title is 1–16384 bytes and body is 0–16384 bytes. Both out-of-range cases
 * are `content_too_large`, so callers never see the table CHECK error.
 * A non-string is `validation_failed`.
 */
export function assertAnnouncementContent(title: unknown, body: unknown): { title: string; body: string } {
  if (typeof title !== 'string') throw new DomainError('validation_failed', { field: 'title' });
  if (typeof body !== 'string') throw new DomainError('validation_failed', { field: 'body' });
  const titleBytes = Buffer.byteLength(title);
  const bodyBytes = Buffer.byteLength(body);
  if (titleBytes < 1 || titleBytes > MAX_ANNOUNCEMENT_BYTES || bodyBytes > MAX_ANNOUNCEMENT_BYTES) {
    throw new DomainError('content_too_large');
  }
  return { title, body };
}

/** The first publish uses 0. Any other non-integer or negative value is rejected before a write. */
export function assertExpectedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new DomainError('validation_failed', { field: 'expectedVersion' });
  }
  return value;
}

export function assertAnnouncementScope(value: unknown): AnnouncementScope {
  if (value !== 'site' && value !== 'org') throw new DomainError('validation_failed', { field: 'scope' });
  return value;
}

export function assertRevisionLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_REVISION_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_REVISION_LIMIT) {
    throw new DomainError('validation_failed', { field: 'limit' });
  }
  return value;
}
