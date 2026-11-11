import { DomainError } from '../kernel';
import { reservedOrgSlugs } from './reserved-slugs';

/** 2–40 characters. The first is a letter or digit; the rest may include hyphens. */
export const organizationSlugPattern = /^[a-z0-9][a-z0-9-]{1,39}$/;

export function parseOrganizationSlug(value: string): string {
  if (typeof value !== 'string') throw new DomainError('validation_failed', { field: 'slug', reason: 'Enter a public address.' });
  const slug = value.trim();
  if (!organizationSlugPattern.test(slug)) {
    throw new DomainError('validation_failed', {
      field: 'slug',
      reason: 'Use 2–40 characters: lowercase letters, numbers, and hyphens, starting with a letter or number.',
    });
  }
  if (reservedOrgSlugs.has(slug)) {
    throw new DomainError('validation_failed', { field: 'slug', reason: 'That public address is reserved.' });
  }
  return slug;
}
