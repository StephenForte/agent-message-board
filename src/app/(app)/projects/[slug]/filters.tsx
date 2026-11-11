import Link from 'next/link';
import { boardSearchParams, categories, type BoardFilters, projectPath } from './composer-model';

export function Filters({ slug, filters, agents }: {
  slug: string;
  filters: BoardFilters;
  agents: Array<{ id: string; name: string }>;
}) {
  return (
    <form id="board-filters" key={boardSearchParams(filters) || 'default'} method="get" action={projectPath(slug)} className="grid gap-3 rounded border p-4 sm:grid-cols-2">
      <div className="block space-y-1 sm:col-span-2">
        <label htmlFor="filter-search">Search</label>
        <input id="filter-search" className="block w-full rounded border p-2" name="q" defaultValue={filters.query ?? ''} />
      </div>
      <div className="block space-y-1">
        <label htmlFor="filter-author">Author</label>
        <select id="filter-author" className="block w-full rounded border p-2" name="author" defaultValue={filters.author ?? ''}>
          <option value="">Anyone</option>
          <option value="human">Human (you)</option>
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select>
      </div>
      <div className="block space-y-1">
        <label htmlFor="filter-recipient">Recipient</label>
        <select id="filter-recipient" className="block w-full rounded border p-2" name="recipient" defaultValue={filters.recipient ?? ''}>
          <option value="">Anyone</option>
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select>
      </div>
      <div className="block space-y-1">
        <label htmlFor="filter-category">Category</label>
        <select id="filter-category" className="block w-full rounded border p-2" name="category" defaultValue={filters.category ?? ''}>
          <option value="">Any</option>
          {categories.map((category) => <option key={category} value={category}>{category}</option>)}
        </select>
      </div>
      <div className="block space-y-1">
        <label htmlFor="filter-urgent">Urgent</label>
        <select id="filter-urgent" className="block w-full rounded border p-2" name="urgent" defaultValue={filters.urgent === true ? 'yes' : filters.urgent === false ? 'no' : ''}>
          <option value="">Any</option>
          <option value="yes">Urgent</option>
          <option value="no">Not urgent</option>
        </select>
      </div>
      <div className="block space-y-1">
        <label htmlFor="filter-pinned">Pinned</label>
        <select id="filter-pinned" className="block w-full rounded border p-2" name="pinned" defaultValue={filters.pinned === true ? 'yes' : filters.pinned === false ? 'no' : ''}>
          <option value="">Any</option>
          <option value="yes">Pinned</option>
          <option value="no">Not pinned</option>
        </select>
      </div>
      <div className="block space-y-1">
        <label htmlFor="filter-status">Status</label>
        <select id="filter-status" className="block w-full rounded border p-2" name="status" defaultValue={filters.status}>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">Active and archived</option>
        </select>
      </div>
      <div className="flex items-end gap-3">
        {filters.sort !== 'activity' ? <input type="hidden" name="sort" value={filters.sort} /> : null}
        <button type="submit" className="rounded bg-blue-700 px-4 py-2 font-medium text-white">Apply filters</button>
        <Link className="underline" href={`${projectPath(slug)}${boardSearchParams({ status: 'active', sort: 'activity' })}`}>Clear filters</Link>
      </div>
    </form>
  );
}
