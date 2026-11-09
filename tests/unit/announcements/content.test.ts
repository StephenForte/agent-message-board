import { expect, test } from 'vitest';
import {
  assertAnnouncementContent,
  assertAnnouncementScope,
  assertExpectedVersion,
  assertRevisionLimit,
  MAX_ANNOUNCEMENT_BYTES,
} from '../../../src/domain/announcements/content';
import { DomainError } from '../../../src/domain/kernel/errors';
import type { AgentPrincipal, HumanPrincipal, SystemPrincipal } from '../../../src/domain/kernel/principal';
import {
  clearOrgAnnouncement,
  clearSiteAnnouncement,
  listAnnouncementRevisions,
  setOrgAnnouncement,
  setSiteAnnouncement,
} from '../../../src/domain/announcements';

const human: HumanPrincipal = {
  kind: 'human', userId: 'user-1', orgId: '00000000-0000-7000-8000-000000000001',
  siteAdmin: true, interface: 'web', requestId: 'req-human',
};

const agent: AgentPrincipal = {
  kind: 'agent', orgId: '00000000-0000-7000-8000-000000000001', tokenId: '00000000-0000-7000-8000-000000000002',
  scope: 'org', projectIds: 'all', canCreateProjects: false, agentId: null, sessionId: null,
  interface: 'mcp', requestId: 'req-agent',
};

const system: SystemPrincipal = {
  kind: 'system', orgId: '00000000-0000-7000-8000-000000000001', interface: 'cli', requestId: 'req-system',
};

test('title and body limits are UTF-8 bytes', () => {
  expect(assertAnnouncementContent('a', '')).toEqual({ title: 'a', body: '' });
  expect(assertAnnouncementContent('a'.repeat(MAX_ANNOUNCEMENT_BYTES), 'b'.repeat(MAX_ANNOUNCEMENT_BYTES))).toEqual({
    title: 'a'.repeat(MAX_ANNOUNCEMENT_BYTES),
    body: 'b'.repeat(MAX_ANNOUNCEMENT_BYTES),
  });
  expect(assertAnnouncementContent('é'.repeat(MAX_ANNOUNCEMENT_BYTES / 2), 'ok')).toEqual({
    title: 'é'.repeat(MAX_ANNOUNCEMENT_BYTES / 2),
    body: 'ok',
  });
  expect(() => assertAnnouncementContent('', 'body')).toThrow(DomainError);
  expect(() => assertAnnouncementContent('', 'body')).toThrowError(expect.objectContaining({ code: 'content_too_large' }));
  expect(() => assertAnnouncementContent('a'.repeat(MAX_ANNOUNCEMENT_BYTES + 1), 'body')).toThrowError(
    expect.objectContaining({ code: 'content_too_large' }),
  );
  expect(() => assertAnnouncementContent('title', 'b'.repeat(MAX_ANNOUNCEMENT_BYTES + 1))).toThrowError(
    expect.objectContaining({ code: 'content_too_large' }),
  );
  expect(() => assertAnnouncementContent(`${'é'.repeat(MAX_ANNOUNCEMENT_BYTES / 2)}é`, 'body')).toThrowError(
    expect.objectContaining({ code: 'content_too_large' }),
  );
  expect(() => assertAnnouncementContent(1, 'body')).toThrowError(
    expect.objectContaining({ code: 'validation_failed', details: { field: 'title' } }),
  );
  expect(() => assertAnnouncementContent('title', null)).toThrowError(
    expect.objectContaining({ code: 'validation_failed', details: { field: 'body' } }),
  );
});

test('version, scope, and revision limit are validated before a write', () => {
  expect(assertExpectedVersion(0)).toBe(0);
  expect(() => assertExpectedVersion(-1)).toThrowError(
    expect.objectContaining({ code: 'validation_failed', details: { field: 'expectedVersion' } }),
  );
  expect(() => assertExpectedVersion(1.5)).toThrowError(
    expect.objectContaining({ code: 'validation_failed' }),
  );
  expect(assertAnnouncementScope('site')).toBe('site');
  expect(assertAnnouncementScope('org')).toBe('org');
  expect(() => assertAnnouncementScope('project')).toThrowError(
    expect.objectContaining({ code: 'validation_failed', details: { field: 'scope' } }),
  );
  expect(assertRevisionLimit(undefined)).toBe(20);
  expect(assertRevisionLimit(100)).toBe(100);
  expect(() => assertRevisionLimit(0)).toThrowError(
    expect.objectContaining({ code: 'validation_failed', details: { field: 'limit' } }),
  );
  expect(() => assertRevisionLimit(101)).toThrowError(
    expect.objectContaining({ code: 'validation_failed', details: { field: 'limit' } }),
  );
});

test('non-human principals cannot set, clear, or list announcement history', async () => {
  const content = { title: 'Hello', body: 'there', expectedVersion: 0 };
  for (const principal of [agent, system]) {
    await expect(setOrgAnnouncement(principal, content)).rejects.toMatchObject({ code: 'capability_denied' });
    await expect(clearOrgAnnouncement(principal, { expectedVersion: 1 })).rejects.toMatchObject({ code: 'capability_denied' });
    await expect(setSiteAnnouncement(principal, content)).rejects.toMatchObject({ code: 'capability_denied' });
    await expect(clearSiteAnnouncement(principal, { expectedVersion: 1 })).rejects.toMatchObject({ code: 'capability_denied' });
    await expect(listAnnouncementRevisions(principal, { scope: 'org' })).rejects.toMatchObject({ code: 'capability_denied' });
    await expect(listAnnouncementRevisions(principal, { scope: 'site' })).rejects.toMatchObject({ code: 'capability_denied' });
  }
  await expect(setOrgAnnouncement(human, { title: '', body: 'x', expectedVersion: 0 })).rejects.toMatchObject({
    code: 'content_too_large',
  });
  await expect(setSiteAnnouncement(human, { title: 'ok', body: 'x'.repeat(MAX_ANNOUNCEMENT_BYTES + 1), expectedVersion: 0 })).rejects.toMatchObject({
    code: 'content_too_large',
  });
  await expect(listAnnouncementRevisions(human, { scope: 'org', limit: 101 })).rejects.toMatchObject({
    code: 'validation_failed', details: { field: 'limit' },
  });
  await expect(listAnnouncementRevisions(human, { scope: 'project' as 'org' })).rejects.toMatchObject({
    code: 'validation_failed', details: { field: 'scope' },
  });
});
