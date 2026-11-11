import { randomUUID } from 'node:crypto';
import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { Avatar } from '../../../../../../components/board/avatar';
import { CategoryPill, FlagPill } from '../../../../../../components/board/pills';
import { TimeStamp } from '../../../../../../components/board/time';
import { Markdown } from '../../../../../../components/markdown/Markdown';
import { listAgents, listTokens } from '../../../../../../domain/credentials';
import { prefixLabel } from '../../../../tokens/format';
import { DomainError } from '../../../../../../domain/kernel';
import { getThread, getThreadHistory } from '../../../../../../domain/messages';
import { ReplyComposer } from '../../composer';
import { authorLabel, formatFlagState, projectPath, threadPath } from '../../composer-model';
import { domainMessage } from '../../domain-message';
import { loadHumanProject } from '../../load-project';
import { FlagControls } from './flags';
import type { FlagSnapshot } from './actions';

function flagSnapshot(status: 'active' | 'archived', urgent: boolean | null, pinned: boolean | null, version: number | null): FlagSnapshot | null {
  if (typeof urgent !== 'boolean' || typeof pinned !== 'boolean' || typeof version !== 'number') return null;
  return { status, urgent, pinned, version };
}

function AuthorBlock({ kind, name, tokenId, prefixes }: {
  kind: string;
  name: string;
  tokenId: string | null;
  prefixes: Map<string, string>;
}) {
  const prefix = kind === 'agent' && tokenId ? prefixes.get(tokenId) : undefined;
  return <div className="space-y-1">
    <Avatar name={name} kind={kind} />
    <p>{authorLabel(kind, name)}</p>
    {prefix ? <p>Token prefix {prefixLabel(prefix)}</p> : null}
  </div>;
}

function one(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export default function ThreadPage(props: {
  params: Promise<{ slug: string; rootId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<p role="status">Loading the thread…</p>}>
      <ThreadContents {...props} />
    </Suspense>
  );
}

async function ThreadContents({ params, searchParams }: {
  params: Promise<{ slug: string; rootId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, rootId } = await params;
  const replyCursor = one((await searchParams).replyCursor);
  const { principal, project } = await loadHumanProject(slug);
  let thread: Awaited<ReturnType<typeof getThread>>;
  try {
    thread = await getThread(principal, { rootId, replyLimit: 20, ...(replyCursor ? { replyCursor } : {}) });
  } catch (error) {
    if (error instanceof DomainError && (error.code === 'forbidden_or_not_found' || error.code === 'validation_failed')) notFound();
    if (error instanceof DomainError && error.code === 'invalid_cursor') {
      return (
        <div role="alert" className="space-y-2">
          <p>{domainMessage(error)}</p>
          <a className="underline" href={threadPath(slug, rootId)}>Start again from the first replies</a>
        </div>
      );
    }
    throw error;
  }
  if (thread.project.slug !== project.slug) notFound();
  const history = await getThreadHistory(principal, rootId);
  const [agentRows, tokenRows] = await Promise.all([listAgents(principal), listTokens(principal)]);
  const agents = agentRows.map((agent) => ({ id: agent.id, name: agent.name }));
  const prefixes = new Map(tokenRows.map((token) => [token.id, token.prefix]));
  const root = thread.root;
  const snapshot = root.status === 'active' || root.status === 'archived' ? flagSnapshot(root.status, root.urgent, root.pinned, root.version) : null;
  const projectReadOnly = project.status === 'archived';
  return (
    <div id="thread-content" className="space-y-8">
      <p><a className="underline" href={projectPath(slug)}>Back to the board</a></p>
      <article className="space-y-3 rounded-lg border border-stone-200 bg-white p-4">
        <h2 className="text-2xl font-semibold break-words">{root.title}</h2>
        <AuthorBlock kind={root.authorKind} name={root.authorDisplayName} tokenId={root.authorTokenId} prefixes={prefixes} />
        <p>Category: {root.category ?? 'note'}</p>
        <p className="flex flex-wrap gap-1.5">
          <CategoryPill category={root.category ?? 'note'} />
          {root.urgent ? <FlagPill>Urgent</FlagPill> : null}
          {root.pinned ? <FlagPill>Pinned</FlagPill> : null}
        </p>
        <ul aria-label="Flags">
          <li>Status: {root.status}</li>
          <li>Urgent: {root.urgent ? 'yes' : 'no'}</li>
          <li>Pinned: {root.pinned ? 'yes' : 'no'}</li>
          <li>Version: {root.version}</li>
        </ul>
        <p>Posted <TimeStamp iso={root.createdAt} /></p>
        <p>Updated <TimeStamp iso={root.updatedAt} /></p>
        {root.recipients.length > 0 ? (
          <ul aria-label="Recipients">{root.recipients.map((recipient) => <li key={recipient.id}>{recipient.name}</li>)}</ul>
        ) : <p>No recipients</p>}
        <div className="break-words"><Markdown>{root.body}</Markdown></div>
      </article>
      {snapshot && !projectReadOnly ? (
        <FlagControls slug={slug} rootId={root.id} snapshot={snapshot} keys={{ urgent: randomUUID(), pinned: randomUUID(), status: randomUUID() }} />
      ) : null}
      <section className="space-y-4" aria-labelledby="replies-heading">
        <h2 id="replies-heading" className="text-xl font-semibold">Replies ({thread.replyCount})</h2>
        {thread.replies.length === 0 ? <p>No replies yet.</p> : thread.replies.map((reply) => (
          <article key={reply.id} className="space-y-2 rounded-lg border border-stone-200 bg-white p-4">
            <AuthorBlock kind={reply.authorKind} name={reply.authorDisplayName} tokenId={reply.authorTokenId} prefixes={prefixes} />
            <p><TimeStamp iso={reply.createdAt} /></p>
            {reply.recipients.length > 0 ? (
              <ul aria-label="Recipients">{reply.recipients.map((recipient) => <li key={recipient.id}>{recipient.name}</li>)}</ul>
            ) : <p>No recipients</p>}
            <div className="break-words"><Markdown>{reply.body}</Markdown></div>
          </article>
        ))}
        {thread.nextReplyCursor ? (
          <p><a className="underline" href={`${threadPath(slug, rootId)}?${new URLSearchParams({ replyCursor: thread.nextReplyCursor })}`}>More replies</a></p>
        ) : null}
      </section>
      {projectReadOnly ? null : (
        <ReplyComposer slug={slug} rootId={root.id} idempotencyKey={randomUUID()} agents={agents} disabled={root.status === 'archived'} />
      )}
      <section id="change-history" aria-labelledby="history-heading" className="space-y-3">
        <h2 id="history-heading" className="text-xl font-semibold">Change history</h2>
        {history.length === 0 ? <p>No flag or lifecycle changes yet.</p> : (
          <ol className="space-y-2">
            {history.map((row) => (
              <li key={row.id}>
                <TimeStamp iso={row.createdAt} />
                {' '}{row.actorKind === 'human' ? 'Human' : row.actorKind === 'agent' ? 'Agent' : 'System'}
                {' via '}{row.interfaceKind}
                {' '}{formatFlagState(row.before)} → {formatFlagState(row.after)}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
