import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { RecipientHint } from '../../../src/app/(app)/projects/[slug]/recipient-hint';
import {
  BODY_BYTE_LIMIT, RECIPIENT_HINT, TEMPLATES, bodyByteLength, bodyExceedsLimit, parseBoardQuery,
} from '../../../src/app/(app)/projects/[slug]/composer-model';

test('handoff template asks for what changed, rationale, remaining work, and references', () => {
  const body = TEMPLATES.handoff.body;
  expect(body).toMatch(/what changed/i);
  expect(body).toMatch(/rationale/i);
  expect(body).toMatch(/remaining work/i);
  expect(body).toMatch(/references/i);
  expect(TEMPLATES.handoff.category).toBe('handoff');
  expect(TEMPLATES.decision.category).toBe('decision');
  expect(TEMPLATES.blocker.category).toBe('blocker');
  expect(TEMPLATES.decision.body.length).toBeGreaterThan(0);
  expect(TEMPLATES.blocker.body.length).toBeGreaterThan(0);
});

test('recipient copy says routing hints are not private', () => {
  expect(RECIPIENT_HINT).toBe('Recipients are routing hints and are not private.');
  expect(renderToStaticMarkup(<RecipientHint />)).toContain(RECIPIENT_HINT);
});

test('client-side byte limit counts UTF-8 bytes and stops at 32 KiB', () => {
  expect(BODY_BYTE_LIMIT).toBe(32768);
  expect(bodyExceedsLimit('a'.repeat(32768))).toBe(false);
  expect(bodyExceedsLimit('a'.repeat(32769))).toBe(true);
  expect(bodyByteLength('é'.repeat(16384))).toBe(32768);
  expect(bodyExceedsLimit('é'.repeat(16385))).toBe(true);
  expect(bodyByteLength('😀'.repeat(8192))).toBe(32768);
  expect(bodyExceedsLimit('😀'.repeat(8193))).toBe(true);
});

test('author filter is human or an agent id, not a user id from the query', () => {
  const agentId = '018f3b2e-7c4a-7b2e-8a1c-9d0e1f2a3b4c';
  expect(parseBoardQuery({ author: 'human' }).author).toBe('human');
  expect(parseBoardQuery({ author: agentId }).author).toBe(agentId);
  expect(parseBoardQuery({ author: '018f3b2e-7c4a-4b2e-8a1c-9d0e1f2a3b4c' }).author).toBeUndefined();
  expect(parseBoardQuery({ author: 'user-123' }).author).toBeUndefined();
});
