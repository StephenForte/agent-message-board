import { notFound } from 'next/navigation';
import { ThreadList, ThreadRow } from '../../../components/board';
import { DomainError } from '../../../domain/kernel';
import { listPublicThreads } from '../../../domain/publicboard';
import { PublicChrome } from '../chrome';
import { oneParam, publicHref, publicThreadHref } from '../paths';

export const dynamic = 'force-dynamic';

export default async function PublicBoardPage({ params, searchParams }: {
  params: Promise<{ org: string; project: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org, project } = await params;
  const query = await searchParams;
  const sortParam = oneParam(query.sort);
  const text = oneParam(query.q);
  const cursor = oneParam(query.cursor);
  let page: Awaited<ReturnType<typeof listPublicThreads>>;
  try {
    page = await listPublicThreads({
      orgSlug: org,
      projectSlug: project,
      ...(sortParam ? { sort: sortParam } : {}),
      ...(text ? { query: text } : {}),
      ...(cursor ? { cursor } : {}),
    });
  } catch (error) {
    if (error instanceof DomainError) notFound();
    throw error;
  }
  const sort = sortParam === 'newest' ? 'newest' : 'activity';
  const tabs = [
    { id: 'active', label: 'Active', href: publicHref(org, project, { query: text }) },
    { id: 'newest', label: 'Newest', href: publicHref(org, project, { sort: 'newest', query: text }) },
  ] as const;
  return <PublicChrome project={page.project}>
    <nav aria-label="Thread views" className="flex gap-1 overflow-x-auto border-b border-stone-200">
      {tabs.map((tab) => {
        const selected = (tab.id === 'newest' && sort === 'newest') || (tab.id === 'active' && sort !== 'newest');
        return <a key={tab.id} href={tab.href} aria-current={selected ? 'page' : undefined}
          className={`shrink-0 px-3 py-2 text-sm ${selected ? 'border-b-2 border-blue-800 font-semibold text-stone-950' : 'text-stone-600'}`}>{tab.label}</a>;
      })}
    </nav>
    <form role="search" method="get" action={publicHref(org, project)} className="flex min-w-0 items-center gap-2">
      {sort === 'newest' ? <input type="hidden" name="sort" value="newest" /> : null}
      <label htmlFor="public-search" className="sr-only">Search this project</label>
      <input id="public-search" name="q" defaultValue={text ?? ''} placeholder="Search this project" className="block w-full min-w-0 rounded border border-stone-300 bg-white px-3 py-2" />
      <button type="submit" className="shrink-0 rounded border border-stone-300 px-3 py-2">Search</button>
    </form>
    <section id="thread-list" aria-labelledby="thread-list-heading" className="space-y-3">
      <h2 id="thread-list-heading" className="text-xl font-semibold">Threads</h2>
      {page.items.length === 0 ? <p>{text ? 'No threads match this search.' : 'No active threads.'}</p> : (
        <ThreadList labelledBy="thread-list-heading">
          {page.items.map((item) => <li key={item.id}>
            <ThreadRow headingId={`thread-${item.id}`} thread={{
              id: item.id,
              href: publicThreadHref(org, project, item.id),
              title: item.title,
              excerpt: item.excerpt,
              replyCount: item.replyCount,
              authorName: item.author.displayName,
              authorKind: item.author.kind,
              category: item.category,
              urgent: item.urgent,
              pinned: item.pinned,
              lastActivityAt: item.lastActivityAt,
            }} />
          </li>)}
        </ThreadList>
      )}
      {page.nextCursor ? <p><a id="thread-list-next" className="underline" href={publicHref(org, project, { sort, query: text, cursor: page.nextCursor })}>Next page</a></p> : null}
    </section>
  </PublicChrome>;
}
