import { Markdown } from '../../../../components/markdown/Markdown';
import { listThreads } from '../../../../domain/messages';
import { authorLabel, boardSearchParams, type BoardFilters, projectPath, threadPath } from './composer-model';

type Listed = Awaited<ReturnType<typeof listThreads>>;

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
        <ul className="space-y-4">
          {threads.items.map((item) => (
            <li key={item.id}>
              <article className="space-y-2 rounded border p-4" aria-labelledby={`${id}-${item.id}`}>
                <h3 id={`${id}-${item.id}`} className="text-lg font-medium break-words">
                  <a className="underline" href={threadPath(slug, item.id)}>{item.title}</a>
                </h3>
                <p>{authorLabel(item.authorKind, item.authorDisplayName)}</p>
                <p>Status: {item.status} · Urgent: {item.urgent ? 'yes' : 'no'} · Pinned: {item.pinned ? 'yes' : 'no'} · {item.category}</p>
                <p><time dateTime={item.lastActivityAt}>{item.lastActivityAt}</time> · {item.replyCount} {item.replyCount === 1 ? 'reply' : 'replies'}</p>
                {item.recipients.length > 0 ? (
                  <ul aria-label="Recipients">{item.recipients.map((recipient) => <li key={recipient.id}>{recipient.name}</li>)}</ul>
                ) : <p>No recipients</p>}
                <div className="break-words"><Markdown>{item.excerpt}</Markdown></div>
                {item.bodyTruncated ? <p>Excerpt truncated.</p> : null}
                {item.matches.length > 0 ? (
                  <ul aria-label="Search matches" className="space-y-2">
                    {item.matches.map((match) => (
                      <li key={match.id} className="rounded border p-2">
                        <p>{match.rootId ? 'Reply match' : 'Root match'}</p>
                        <div className="break-words"><Markdown>{match.excerpt}</Markdown></div>
                        {match.bodyTruncated ? <p>Excerpt truncated.</p> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {item.matchesTruncated ? <p>More matches are in the thread.</p> : null}
              </article>
            </li>
          ))}
        </ul>
      )}
      {more && threads.nextCursor ? <p><a className="underline" href={`${projectPath(slug)}${boardSearchParams(more.filters)}`}>{more.label}</a></p> : null}
      {id === 'thread-list' && threads.nextCursor ? (
        <p><a id="thread-list-next" className="underline" href={`${projectPath(slug)}${boardSearchParams(filters, threads.nextCursor)}`}>Next page</a></p>
      ) : null}
    </section>
  );
}
