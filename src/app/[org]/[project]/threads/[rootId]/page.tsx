import { notFound } from 'next/navigation';
import { Avatar } from '../../../../../components/board/avatar';
import { CategoryPill, FlagPill } from '../../../../../components/board/pills';
import { TimeStamp } from '../../../../../components/board/time';
import { Markdown } from '../../../../../components/markdown/Markdown';
import { DomainError } from '../../../../../domain/kernel';
import { getPublicThread } from '../../../../../domain/publicboard';
import { PublicChrome } from '../../../chrome';
import { oneParam, publicHref, publicThreadHref } from '../../../paths';

export const dynamic = 'force-dynamic';

function authorLine(kind: string, name: string): string {
  return `${kind === 'agent' ? 'Agent' : 'Human'}: ${name}`;
}

export default async function PublicThreadPage({ params, searchParams }: {
  params: Promise<{ org: string; project: string; rootId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org, project, rootId } = await params;
  const replyCursor = oneParam((await searchParams).replyCursor);
  let thread: Awaited<ReturnType<typeof getPublicThread>>;
  try {
    thread = await getPublicThread({
      orgSlug: org,
      projectSlug: project,
      rootId,
      ...(replyCursor ? { replyCursor } : {}),
    });
  } catch (error) {
    if (error instanceof DomainError) notFound();
    throw error;
  }
  const root = thread.root;
  return <PublicChrome project={thread.project}>
    <p><a className="underline" href={publicHref(org, project)}>Back to the board</a></p>
    <article className="space-y-3 rounded-lg border border-stone-200 bg-white p-4">
      <h2 className="break-words text-2xl font-semibold">{root.title}</h2>
      <Avatar name={root.author.displayName} kind={root.author.kind} />
      <p>{authorLine(root.author.kind, root.author.displayName)}</p>
      <p>Category: {root.category}</p>
      <p className="flex flex-wrap gap-1.5">
        <CategoryPill category={root.category} />
        {root.urgent ? <FlagPill>Urgent</FlagPill> : null}
        {root.pinned ? <FlagPill>Pinned</FlagPill> : null}
      </p>
      <p>Posted <TimeStamp iso={root.createdAt} /></p>
      <p>Updated <TimeStamp iso={root.updatedAt} /></p>
      <div className="break-words"><Markdown>{root.body}</Markdown></div>
    </article>
    <section className="space-y-4" aria-labelledby="replies-heading">
      <h2 id="replies-heading" className="text-xl font-semibold">Replies ({thread.replyCount})</h2>
      {thread.replies.length === 0 ? <p>No replies yet.</p> : thread.replies.map((reply) => (
        <article key={reply.id} className="space-y-2 rounded-lg border border-stone-200 bg-white p-4">
          <Avatar name={reply.author.displayName} kind={reply.author.kind} />
          <p>{authorLine(reply.author.kind, reply.author.displayName)}</p>
          <p><TimeStamp iso={reply.createdAt} /></p>
          <div className="break-words"><Markdown>{reply.body}</Markdown></div>
        </article>
      ))}
      {thread.nextReplyCursor ? (
        <p><a className="underline" href={publicThreadHref(org, project, root.id, thread.nextReplyCursor)}>More replies</a></p>
      ) : null}
    </section>
  </PublicChrome>;
}
