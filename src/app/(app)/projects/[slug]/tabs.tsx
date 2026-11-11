import { boardSearchParams, projectPath, type BoardFilters } from './composer-model';

const tabs = [
  { id: 'active', label: 'Active' },
  { id: 'newest', label: 'Newest' },
  { id: 'urgent', label: 'Urgent' },
  { id: 'pinned', label: 'Pinned' },
  { id: 'archived', label: 'Archived' },
] as const;

export type BoardTab = (typeof tabs)[number]['id'];

export function currentBoardTab(filters: BoardFilters): BoardTab | null {
  if (filters.status === 'archived') return 'archived';
  if (filters.status !== 'active') return null;
  if (filters.urgent === true && filters.pinned === undefined && filters.sort === 'activity') return 'urgent';
  if (filters.pinned === true && filters.urgent === undefined && filters.sort === 'activity') return 'pinned';
  if (filters.urgent !== undefined || filters.pinned !== undefined) return null;
  if (filters.sort === 'newest') return 'newest';
  if (filters.sort === 'activity') return 'active';
  return null;
}

function tabQuery(filters: BoardFilters, tab: BoardTab): BoardFilters {
  const next: BoardFilters = {
    query: filters.query,
    author: filters.author,
    recipient: filters.recipient,
    category: filters.category,
    status: tab === 'archived' ? 'archived' : 'active',
    sort: tab === 'newest' ? 'newest' : 'activity',
  };
  if (tab === 'urgent') next.urgent = true;
  if (tab === 'pinned') next.pinned = true;
  return next;
}

export function BoardTabs({ slug, filters }: { slug: string; filters: BoardFilters }) {
  const current = currentBoardTab(filters);
  return <nav aria-label="Thread views" className="flex gap-1 overflow-x-auto border-b border-stone-200">
    {tabs.map((tab) => {
      const selected = current === tab.id;
      return <a key={tab.id} href={`${projectPath(slug)}${boardSearchParams(tabQuery(filters, tab.id))}`}
        aria-current={selected ? 'page' : undefined}
        className={`shrink-0 px-3 py-2 text-sm ${selected ? 'border-b-2 border-blue-800 font-semibold text-stone-950' : 'text-stone-600'}`}>{tab.label}</a>;
    })}
  </nav>;
}
