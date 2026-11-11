import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { Avatar, avatarColor, initials } from '../../../src/components/board/avatar';
import { excerptText } from '../../../src/components/board/excerpt';
import { CategoryPill, FlagPill, categoryLabel } from '../../../src/components/board/pills';
import { ThreadRow, type ThreadRowModel } from '../../../src/components/board/thread-row';

const categories = ['note', 'finding', 'decision', 'blocker', 'handoff'] as const;

function row(overrides: Partial<ThreadRowModel> = {}): ThreadRowModel {
  return {
    id: 'root-1',
    href: '/projects/pilot/threads/root-1',
    title: 'Habitat notes',
    excerpt: 'Roots stay put.',
    replyCount: 3,
    authorName: 'Ada Lovelace',
    authorKind: 'human',
    category: 'note',
    urgent: false,
    pinned: false,
    lastActivityAt: '2026-11-11T00:00:00.000Z',
    ...overrides,
  };
}

test('initials use the first letters of the name and stay short', () => {
  expect(initials('Ada Lovelace')).toBe('AL');
  expect(initials('ada')).toBe('AD');
  expect(initials('  ')).toBe('?');
  expect(initials('Mary Jane Watson')).toBe('MJ');
});

test('avatar color is stable for a name', () => {
  expect(avatarColor('Ada Lovelace')).toBe(avatarColor('Ada Lovelace'));
  expect(avatarColor('Ada Lovelace')).toMatch(/^#[0-9a-f]{6}$/);
  expect(avatarColor('Ada Lovelace')).not.toBe(avatarColor('Grace Hopper'));
});

test('agent marker is shown only for agent authors', () => {
  const agent = renderToStaticMarkup(<Avatar name="worker" kind="agent" />);
  const human = renderToStaticMarkup(<Avatar name="Ada Lovelace" kind="human" />);
  expect(agent).toContain('Agent');
  expect(agent).toContain(avatarColor('worker'));
  expect(human).not.toContain('>Agent<');
  expect(human).toContain('AL');
});

test('pills name every category and the urgent and pinned flags', () => {
  for (const category of categories) {
    const html = renderToStaticMarkup(<CategoryPill category={category} />);
    expect(html).toContain(categoryLabel(category));
    expect(categoryLabel(category)).toMatch(/^[A-Z]/);
  }
  expect(renderToStaticMarkup(<FlagPill>Urgent</FlagPill>)).toContain('Urgent');
  expect(renderToStaticMarkup(<FlagPill>Pinned</FlagPill>)).toContain('Pinned');
});

test('excerpt stays plain text and truncates with an ellipsis', () => {
  expect(excerptText('short note')).toBe('short note');
  expect(excerptText('line\n\nbreak')).toBe('line break');
  const long = 'word '.repeat(80);
  const truncated = excerptText(long);
  expect(truncated.endsWith('…')).toBe(true);
  expect(truncated.length).toBeLessThanOrEqual(180);
  const hostile = excerptText('[click](https://example.test) <script>alert(1)</script>');
  expect(hostile).toBe('[click](https://example.test) <script>alert(1)</script>');
  const rendered = renderToStaticMarkup(<ThreadRow thread={row({ title: 'Safe title', excerpt: hostile })} headingId="row-safe" />);
  expect(rendered).not.toContain('<script');
  expect(rendered).toContain('&lt;script&gt;');
  expect(rendered).not.toContain('href="https://example.test"');
});

test('a thread row is one link whose accessible name is the title', () => {
  const html = renderToStaticMarkup(<ThreadRow thread={row({
    excerpt: '[click](https://example.test)',
    urgent: true,
    pinned: true,
    authorKind: 'agent',
  })} headingId="thread-list-root-1" />);
  expect(html).toContain('aria-label="Habitat notes"');
  expect(html).toContain('href="/projects/pilot/threads/root-1"');
  expect(html).toContain('id="thread-list-root-1"');
  expect(html).toContain('Habitat notes');
  expect(html).toContain('Urgent');
  expect(html).toContain('Pinned');
  expect(html).toContain('Note');
  expect(html).toContain('>Agent<');
  expect(html).not.toContain('href="https://example.test"');
  expect(html.match(/<a /g)?.length).toBe(1);
});
