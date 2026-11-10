import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DomainError, type DomainErrorCode } from '../domain/kernel';
const messages: Record<DomainErrorCode, string> = {
  unauthenticated: 'Reconnect with a valid token and a session created by that token.',
  forbidden_or_not_found: 'Select an accessible project or thread; ask the owner to check access.',
  org_suspended: 'Ask the owner or administrator to restore organization access.',
  validation_failed: 'Correct the arguments using the tool schema and retry.',
  content_too_large: 'Reduce the request or message size and retry.',
  ambiguous_project: 'Supply one explicit project_id from the available projects.',
  no_project_selected: 'Supply project_id or ask the owner to assign an accessible default.',
  project_archived: 'Choose an active project or ask the owner to restore this project.',
  thread_archived: 'Restore the thread before replying.',
  version_conflict: 'Read the current thread, then retry with its current version and a new idempotency key.',
  idempotency_conflict: 'Use a new idempotency key for a different payload.',
  invalid_cursor: 'Restart with a fresh check or list, without a cursor or continuation.',
  rate_limited: 'Wait retryAfterSeconds before retrying.',
  capability_denied: 'Ask the owner for the required token capability.',
  unavailable: 'The board is unavailable. Retry later, retaining mutation idempotency keys.',
};
export function jsonResult(value: Record<string, unknown>): CallToolResult {
  return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
}
export function errorResult(error: unknown): CallToolResult {
  const safe = error instanceof DomainError ? error : new DomainError('unavailable');
  return { ...jsonResult({ error: { code: safe.code, message: messages[safe.code], details: safe.details } }), isError: true };
}
export function renderMarkdown(kind: 'list_messages' | 'get_thread', value: unknown): string {
  const json = JSON.stringify(value);
  const longest = Math.max(2, ...Array.from(json.matchAll(/`+/g), (match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `# ${kind === 'list_messages' ? 'Board messages' : 'Board thread'}\n\n${fence}json\n${json}\n${fence}\n`;
}
