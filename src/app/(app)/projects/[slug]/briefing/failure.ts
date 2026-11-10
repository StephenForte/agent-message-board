import { notFound, redirect, unstable_rethrow } from 'next/navigation';
import { DomainError } from '../../../../../domain/kernel';
export function briefingFailure(error: unknown) {
  unstable_rethrow(error);
  if (error instanceof DomainError && error.code === 'forbidden_or_not_found') notFound();
  if (error instanceof DomainError && error.code === 'org_suspended') redirect('/suspended');
  if (error instanceof DomainError && error.code === 'invalid_cursor') return 'This briefing continuation is no longer valid. Start a fresh briefing below to resync.';
  if (error instanceof DomainError && error.code === 'validation_failed') return 'The briefing selection is invalid. Start a fresh briefing below.';
  return 'The briefing is unavailable. Try starting a fresh briefing below.';
}
