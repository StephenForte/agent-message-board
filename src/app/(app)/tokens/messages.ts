import { DomainError } from '../../../domain/kernel';

const fields: Record<string, string> = {
  label: 'Enter a label using 200 characters or fewer.',
  scope: 'Choose broad or restricted access.',
  projectIds: 'Choose projects only for a restricted token.',
  canCreateProjects: 'Choose whether this token can create projects.',
  expiresAt: 'Expiry must be a time in the future.',
  name: 'Enter a valid agent name.',
  clientLabel: 'Enter a client label using 200 characters or fewer.',
};

export function plainDomainMessage(error: DomainError): string {
  switch (error.code) {
    case 'validation_failed': {
      const field = typeof error.details.field === 'string' ? error.details.field : '';
      return fields[field] ?? 'Check the form and try again.';
    }
    case 'org_suspended':
      return 'This organization is suspended.';
    case 'unavailable':
      return 'The board is unavailable. Try again.';
    case 'capability_denied':
      return 'You do not have permission to do that.';
    case 'unauthenticated':
      return 'Sign in again to continue.';
    case 'idempotency_conflict':
      return 'This form was already submitted with different details. Reload and try again.';
    case 'forbidden_or_not_found':
      return 'Not found.';
    default:
      return 'The request could not be completed. Try again.';
  }
}
