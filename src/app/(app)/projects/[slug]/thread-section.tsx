import { excerptText } from '../../../../components/board/excerpt';
import { ThreadList, ThreadRow, type ThreadRowModel } from '../../../../components/board/thread-row';
import { listThreads } from '../../../../domain/messages';
import { boardSearchParams, type BoardFilters, projectPath, threadPath } from './composer-model';

type Listed = Awaited<ReturnType<typeof listThreads>>;
type ListedItem = Listed['items'][number];

export function toThreadRow(slug: string, item: ListedItem, projectLabel?: string): ThreadRowModel {
  return {
    id: item.id,
    href: threadPath(slug, item.id),
    title: item.title?.trim() || 'Untitled',
    excerpt: item.excerpt,
    replyCount: Number(item.replyCount) || 0,
    authorName: item.authorDisplayName,
    authorKind: item.authorKind,
    category: item.category ?? 'note',
    urgent: item.urgent === true,
    pinned: item.pinned === true,
    lastActivityAt: item.lastActivityAt,
    projectLabel,
  };
}

export function ThreadSection({ id, title, empty, threads, slug, filters, more }: {
  id: string;
  title: string;
  empty: string;
  threads: Listed;
  slug: string;
  filters: BoardFilters;
  more?: { label: string; filters: BoardFilters };
}) {
  const headingId = `${id}-heading`;
  return (
    <section id={id} aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="text-xl font-semibold">{title}</h2>
      {threads.items.length === 0 ? <p>{empty}</p> : (
        <ThreadList labelledBy={headingId}>
          {threads.items.map((item) => (
            <li key={item.id}>
              <ThreadRow thread={toThreadRow(slug, item)} headingId={`${id}-${item.id}`} />
              {item.matches.length > 0 ? (
                <ul aria-label="Search matches" className="space-y-2 px-3 pb-3">
                  {item.matches.map((match) => (
                    <li key={match.id} className="rounded border border-stone-200 p-2">
                      <p>{match.rootId ? 'Reply match' : 'Root match'}</p>
                      <p className="excerpt-clamp break-words text-sm text-stone-700">{excerptText(match.excerpt)}</p>
                      {match.bodyTruncated ? <p>Excerpt truncated.</p> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {item.matchesTruncated ? <p className="px-3 pb-3">More matches are in the thread.</p> : null}
            </li>
          ))}
        </ThreadList>
      )}
      {more && threads.nextCursor ? <p><a className="underline" href={`${projectPath(slug)}${boardSearchParams(more.filters)}`}>{more.label}</a></p> : null}
      {id === 'thread-list' && threads.nextCursor ? (
        <p><a id="thread-list-next" className="underline" href={`${projectPath(slug)}${boardSearchParams(filters, threads.nextCursor)}`}>Next page</a></p>
      ) : null}
    </section>
  );
}
