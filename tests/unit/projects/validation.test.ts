import { expect, test } from 'vitest';
import { requireId, textField } from '../../../src/domain/projects';

test('text limits count Unicode characters and reject blank values', () => {
  expect(() => textField('😀'.repeat(200), 'name', 200)).not.toThrow();
  for (const value of ['', '  ', '😀'.repeat(201)]) expect(() => textField(value, 'name', 200)).toThrow('validation_failed');
});
test('malformed identifiers receive the same non-disclosing domain error', () => {
  for (const value of ['', 'not-a-uuid', "' or true --"]) expect(() => requireId(value)).toThrow('forbidden_or_not_found');
});
