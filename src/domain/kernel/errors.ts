export const domainErrorCodes = [
  'unauthenticated',
  'forbidden_or_not_found',
  'org_suspended',
  'validation_failed',
  'content_too_large',
  'ambiguous_project',
  'no_project_selected',
  'project_archived',
  'thread_archived',
  'version_conflict',
  'idempotency_conflict',
  'invalid_cursor',
  'rate_limited',
  'capability_denied',
  'unavailable',
] as const;

export type DomainErrorCode = (typeof domainErrorCodes)[number];

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: DomainErrorCode, details: Record<string, unknown> = {}) {
    super(code);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export function versionConflict(currentVersion: number, state: unknown): DomainError {
  return new DomainError('version_conflict', { currentVersion, state });
}

export function invalidCursor(resync: string): DomainError {
  return new DomainError('invalid_cursor', { resync });
}

export function rateLimited(retryAfterSeconds: number): DomainError {
  return new DomainError('rate_limited', { retryAfterSeconds });
}
