import { expect, test } from 'vitest';
import { defaultCanCreateProjects, scopeCopy } from '../../../src/app/(app)/tokens/copy';

test('scope copy distinguishes broad and restricted access', () => {
  expect(scopeCopy('org')).toBe('Broad access includes all current and future projects.');
  expect(scopeCopy('projects')).toBe('Restricted access includes only the listed projects.');
  expect(scopeCopy('org')).not.toContain('only the listed projects');
  expect(scopeCopy('projects')).not.toContain('all current and future projects');
});

test('can-create-projects defaults follow scope', () => {
  expect(defaultCanCreateProjects('org')).toBe(true);
  expect(defaultCanCreateProjects('projects')).toBe(false);
  expect(defaultCanCreateProjects('org', false)).toBe(false);
  expect(defaultCanCreateProjects('projects', false)).toBe(false);
});
