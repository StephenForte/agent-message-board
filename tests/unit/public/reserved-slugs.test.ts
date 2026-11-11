import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, test } from 'vitest';
import { parseOrganizationSlug } from '../../../src/domain/organizations/slug';
import { publicRobotsTag, reservedOrgSlugs } from '../../../src/domain/organizations/reserved-slugs';
import { proxy } from '../../../src/proxy';

const extras = ['_next', 'p', 'public', 'static', 'favicon.ico', 'robots.txt'];

function scanTopLevelRoutes(appDir: string): Set<string> {
  const found = new Set<string>();
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if ((name.startsWith('(') && name.endsWith(')')) || name.startsWith('@') || name.startsWith('_')) {
        walk(join(dir, name));
        continue;
      }
      if (name.startsWith('[')) continue;
      found.add(name);
    }
  }
  walk(appDir);
  return found;
}

test('reserved organization slugs cover every top-level app route', () => {
  const scanned = scanTopLevelRoutes('src/app');
  expect(scanned.has('projects')).toBe(true);
  expect(scanned.has('sign-in')).toBe(true);
  expect(scanned.has('admin')).toBe(true);
  expect([...scanned].some((name) => name.startsWith('['))).toBe(false);
  const expected = [...new Set([...scanned, ...extras])].sort();
  expect([...reservedOrgSlugs].sort()).toEqual(expected);
});

test('organization slug rejects reserved names and malformed text', () => {
  expect(parseOrganizationSlug('  acme-board  ')).toBe('acme-board');
  for (const slug of ['projects', 'sign-in', 'admin', 'api', 'tokens', 'agents', 'connect', 'settings', '_next', 'favicon.ico', 'robots.txt', 'p', 'public', 'static']) {
    expect(() => parseOrganizationSlug(slug)).toThrowError(expect.objectContaining({ code: 'validation_failed', details: expect.objectContaining({ field: 'slug' }) }));
  }
  for (const slug of ['A', 'a', 'ab_c', 'has space', '-ab', 'a'.repeat(41), '', 'Acme']) {
    expect(() => parseOrganizationSlug(slug)).toThrowError(expect.objectContaining({ code: 'validation_failed' }));
  }
});

test('public routes set X-Robots-Tag noindex and reserved prefixes do not', async () => {
  const listed = proxy(new NextRequest('https://localhost/acme/board'));
  expect(listed.headers.get('X-Robots-Tag')).toBe('noindex');
  const thread = proxy(new NextRequest('https://localhost/acme/board/threads/00000000-0000-4000-8000-000000000001'));
  expect(thread.headers.get('X-Robots-Tag')).toBe('noindex');
  const missing = proxy(new NextRequest('https://localhost/no-such-org/no-such-project'));
  expect(missing.headers.get('X-Robots-Tag')).toBe('noindex');
  for (const path of ['/projects/alpha', '/admin', '/sign-in', '/api/health', '/acme']) {
    expect(proxy(new NextRequest(`https://localhost${path}`)).headers.get('X-Robots-Tag'), path).toBeNull();
    expect(publicRobotsTag(path), path).toBeNull();
  }
});
