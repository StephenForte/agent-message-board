import { expect, test } from 'vitest';
import { DomainError } from '../../../src/domain/kernel';
import { loadFailureMessage } from '../../../src/app/(app)/projects/[slug]/domain-message';

test('a failed board or thread load offers a retry and hides driver errors', () => {
  expect(loadFailureMessage(new DomainError('rate_limited'), 'board')).toBe('Too many requests. Wait a moment and try again.');
  expect(loadFailureMessage(new DomainError('unavailable'), 'board')).toBe('The board is temporarily unavailable. Try again.');
  expect(loadFailureMessage(new DomainError('unavailable'), 'thread')).toBe('The thread is temporarily unavailable. Try again.');
  expect(loadFailureMessage(new Error('connect ECONNREFUSED'), 'thread')).toBe('The thread could not be loaded. Try again.');
  expect(loadFailureMessage(new Error('password authentication failed'), 'board')).not.toMatch(/password|ECONNREFUSED/);
});
