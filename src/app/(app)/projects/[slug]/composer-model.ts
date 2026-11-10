export const BODY_BYTE_LIMIT = 32768;

export const categories = ['note', 'finding', 'decision', 'blocker', 'handoff'] as const;
export type Category = (typeof categories)[number];

export const RECIPIENT_HINT = 'Recipients are routing hints and are not private.';

export const TEMPLATES = {
  decision: {
    category: 'decision',
    label: 'Decision',
    body: '## Decision\n\n**Context**\n\n**Decision**\n\n**Consequences**\n',
  },
  blocker: {
    category: 'blocker',
    label: 'Blocker',
    body: '## Blocker\n\n**What is blocked**\n\n**Why it is blocked**\n\n**Needed to unblock**\n',
  },
  handoff: {
    category: 'handoff',
    label: 'Handoff',
    body: '## Handoff\n\n**What changed**\n\n**Rationale**\n\n**Remaining work**\n\n**References**\n\nFiles, commits, or pull requests.\n',
  },
} as const;

export type TemplateName = keyof typeof TEMPLATES;

const agentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type BoardFilters = {
  query?: string;
  author?: 'human' | string;
  recipient?: string;
  category?: Category;
  urgent?: boolean;
  pinned?: boolean;
  status: 'active' | 'archived' | 'all';
  cursor?: string;
};

export type ComposerResult = { ok: false; message: string; idempotencyKey: string };

export function bodyByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function bodyExceedsLimit(value: string): boolean {
  return bodyByteLength(value) > BODY_BYTE_LIMIT;
}

export function authorLabel(kind: string, name: string): string {
  const role = kind === 'agent' ? 'Agent' : kind === 'human' ? 'Human' : 'Author';
  return `${role}: ${name}`;
}

export function formatFlagState(value: unknown): string {
  if (!value || typeof value !== 'object') return 'none';
  const record = value as Record<string, unknown>;
  const status = record.status === 'active' || record.status === 'archived' ? record.status : 'unknown';
  const urgent = record.urgent === true ? 'yes' : 'no';
  const pinned = record.pinned === true ? 'yes' : 'no';
  const version = typeof record.version === 'number' ? String(record.version) : 'unknown';
  return `status ${status}, urgent ${urgent}, pinned ${pinned}, version ${version}`;
}

function one(input: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const value = input[key];
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseBoardQuery(input: Record<string, string | string[] | undefined>): BoardFilters {
  const category = one(input, 'category');
  const status = one(input, 'status');
  const urgent = one(input, 'urgent');
  const pinned = one(input, 'pinned');
  const author = one(input, 'author');
  const recipient = one(input, 'recipient');
  const query = one(input, 'q');
  return {
    query: query?.slice(0, 1000),
    author: author === 'human' ? 'human' : author && agentIdPattern.test(author) ? author.toLowerCase() : undefined,
    recipient: recipient && agentIdPattern.test(recipient) ? recipient.toLowerCase() : undefined,
    category: (categories as readonly string[]).includes(category ?? '') ? category as Category : undefined,
    urgent: urgent === 'yes' ? true : urgent === 'no' ? false : undefined,
    pinned: pinned === 'yes' ? true : pinned === 'no' ? false : undefined,
    status: status === 'archived' || status === 'all' ? status : 'active',
    cursor: one(input, 'cursor'),
  };
}

export function filtersAreDefault(filters: BoardFilters): boolean {
  return !filters.query && !filters.author && !filters.recipient && !filters.category
    && filters.urgent === undefined && filters.pinned === undefined && filters.status === 'active' && !filters.cursor;
}

export function boardSearchParams(filters: BoardFilters, cursor?: string | null): string {
  const params = new URLSearchParams();
  if (filters.query) params.set('q', filters.query);
  if (filters.author) params.set('author', filters.author);
  if (filters.recipient) params.set('recipient', filters.recipient);
  if (filters.category) params.set('category', filters.category);
  if (filters.urgent === true) params.set('urgent', 'yes');
  if (filters.urgent === false) params.set('urgent', 'no');
  if (filters.pinned === true) params.set('pinned', 'yes');
  if (filters.pinned === false) params.set('pinned', 'no');
  if (filters.status !== 'active') params.set('status', filters.status);
  if (cursor) params.set('cursor', cursor);
  const text = params.toString();
  return text ? `?${text}` : '';
}

export function projectPath(slug: string): string {
  return `/projects/${encodeURIComponent(slug)}`;
}

export function threadPath(slug: string, rootId: string): string {
  return `${projectPath(slug)}/threads/${encodeURIComponent(rootId)}`;
}

export function toListInput(projectId: string, filters: BoardFilters, principalUserId: string, extra?: {
  urgent?: boolean; pinned?: boolean; cursor?: string | null; limit?: number;
}) {
  const urgent = extra && 'urgent' in extra ? extra.urgent : filters.urgent;
  const pinned = extra && 'pinned' in extra ? extra.pinned : filters.pinned;
  const cursor = extra && 'cursor' in extra ? extra.cursor ?? undefined : filters.cursor;
  return {
    projectIds: [projectId],
    status: filters.status,
    sort: 'activity' as const,
    limit: extra?.limit ?? 20,
    ...(filters.category ? { category: filters.category } : {}),
    ...(urgent !== undefined ? { urgent } : {}),
    ...(pinned !== undefined ? { pinned } : {}),
    ...(filters.author === 'human' ? { authorUserId: principalUserId } : {}),
    ...(filters.author && filters.author !== 'human' ? { authorAgentId: filters.author } : {}),
    ...(filters.recipient ? { recipientAgentId: filters.recipient } : {}),
    ...(filters.query ? { query: filters.query } : {}),
    ...(cursor ? { cursor } : {}),
  };
}
