import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { Markdown } from '../../src/components/markdown/Markdown';

test.each([
  '<script>alert(1)</script>', '<img src=x onerror="alert(1)">',
  '<iframe src="https://evil.test"></iframe>', '[x](javascript:alert(1))',
  '[x](data:text/html,evil)', '[x](jav&#x61;script:alert(1))',
])('sanitizes hostile Markdown: %s', (input) => {
  const html = renderToStaticMarkup(<Markdown>{input}</Markdown>);
  expect(html).not.toMatch(/<script|<iframe|onerror=|href="(?:javascript|data):/i);
});
test('renders safe headings, lists, code, tables, and HTTPS links', () => {
  const html = renderToStaticMarkup(<Markdown>{'# Heading\n\n- Item\n\n`code`\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n[safe](https://example.test)'}</Markdown>);
  for (const tag of ['<h1>', '<ul>', '<code>', '<table>']) expect(html).toContain(tag);
  expect(html).toContain('href="https://example.test"');
  expect(html).toContain('rel="noopener noreferrer nofollow ugc"');
});
