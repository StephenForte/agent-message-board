export function oneParam(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export function publicHref(org: string, project: string, options: { sort?: 'activity' | 'newest'; query?: string; cursor?: string } = {}): string {
  const params = new URLSearchParams();
  if (options.sort === 'newest') params.set('sort', 'newest');
  if (options.query) params.set('q', options.query);
  if (options.cursor) params.set('cursor', options.cursor);
  const query = params.toString();
  return `/${encodeURIComponent(org)}/${encodeURIComponent(project)}${query ? `?${query}` : ''}`;
}

export function publicThreadHref(org: string, project: string, rootId: string, replyCursor?: string): string {
  const params = new URLSearchParams();
  if (replyCursor) params.set('replyCursor', replyCursor);
  const query = params.toString();
  return `/${encodeURIComponent(org)}/${encodeURIComponent(project)}/threads/${encodeURIComponent(rootId)}${query ? `?${query}` : ''}`;
}
