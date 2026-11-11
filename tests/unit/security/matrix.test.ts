import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { toolNames } from '../../../src/mcp/schemas';

test('capability matrix covers seven roles and every tool with existing executable test citations', () => {
  const matrix = readFileSync(resolve('docs/capability-matrix.md'), 'utf8');
  const rows = matrix.split('\n').filter(line => line.startsWith('| '));
  expect(rows[0].split('|').slice(1, -1)).toHaveLength(8);
  const operations = rows.slice(2).map(row => row.split('|').slice(1, -1).map(cell => cell.trim()));
  expect(operations.length).toBeGreaterThanOrEqual(20);
  for (const name of toolNames) expect(operations.filter(row => row[0] === name)).toHaveLength(1);
  for (const row of operations) {
    expect(row).toHaveLength(8);
    for (const cell of row.slice(1)) {
      expect(cell).toMatch(/^(Allowed|Denied)(?: \([^)]*\))? — `tests\//);
      expect(cell).toContain(' › ');
    }
  }
  const citations = [...matrix.matchAll(/`(tests\/[\w./-]+) › ([^`]+)`/g)];
  expect(citations.length).toBeGreaterThanOrEqual(operations.length * 7);
  for (const [, path, title] of citations) {
    const absolute = resolve(path);
    expect(existsSync(absolute), path).toBe(true);
    const source = readFileSync(absolute, 'utf8');
    expect(source, `${path} › ${title}`).toContain(title);
    expect(source, `${path} must declare a test`).toMatch(/\b(?:test|it)\(/);
  }
});
