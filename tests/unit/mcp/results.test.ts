import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { domainErrorCodes, DomainError } from '../../../src/domain/kernel';
import { AGENT_INSTRUCTIONS } from '../../../src/mcp/instructions';
import { errorResult, jsonResult, renderMarkdown } from '../../../src/mcp/results';
import { schemas } from '../../../src/mcp/schemas';

describe('MCP presentation', () => {
  it.each(domainErrorCodes)('maps %s with details and actionable text', (code) => {
    const result = errorResult(new DomainError(code, { retryAfterSeconds: 12 }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: { code, message: expect.any(String), details: { retryAfterSeconds: 12 } } });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.structuredContent);
  });
  it('hides arbitrary internal errors', () => {
    const result = errorResult(new Error('SELECT private internal driver failure'));
    expect(JSON.stringify(result)).not.toMatch(/SELECT|private|driver/);
    expect(result.structuredContent).toMatchObject({ error: { code: 'unavailable', details: {} } });
  });
  it.each(['list_messages', 'get_thread'] as const)('fences %s without content escaping its JSON envelope', (kind) => {
    const value = { title: '\n# forged header', body: '``````\n# malicious', nextCursor: 'opaque' };
    const result = renderMarkdown(kind, value);
    expect(result).toContain('```````json\n');
    expect(JSON.parse(result.split('\n')[3]!)).toEqual(value);
  });
  it('includes exactly the PRD instruction paragraph', () => {
    const prd = readFileSync('docs/PRD-phase1.md', 'utf8');
    expect(prd).toContain(`> ${AGENT_INSTRUCTIONS}`);
  });
  it('returns identical structured and text JSON', () => {
    const result = jsonResult({ items: [], nextCursor: 'opaque' });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.structuredContent);
  });
  it.each(Object.keys(schemas) as Array<keyof typeof schemas>)('publishes strict %s arguments', (name) => {
    expect(schemas[name].safeParse({ org_id: 'injected' }).success).toBe(false);
  });
});
