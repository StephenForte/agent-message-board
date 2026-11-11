import { randomUUID } from 'node:crypto';
import { Suspense } from 'react';
import { DomainError } from '../../../../domain/kernel';
import { listAgents } from '../../../../domain/credentials';
import { listThreads } from '../../../../domain/messages';
import {
  boardSearchParams, filtersAreDefault, parseBoardQuery, projectPath, toListInput, type BoardFilters,
} from './composer-model';
import { domainMessage } from './domain-message';
import { Filters } from './filters';
import { loadHumanProject } from './load-project';
import { RootComposer } from './composer';
import { BoardTabs } from './tabs';
import { ThreadSection } from './thread-section';

export default function BoardPage(props: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <Suspense fallback={<p role="status">Loading the board…</p>}>
      <BoardContents {...props} />
    </Suspense>
  );
}

async function BoardContents({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const filters = parseBoardQuery(await searchParams);
  const { principal, project } = await loadHumanProject(slug);
  const agents = (await listAgents(principal)).map((agent) => ({ id: agent.id, name: agent.name }));
  const showUrgent = filters.urgent === undefined;
  const showPinned = filters.pinned === undefined;
  const sectionInput = { cursor: null as string | null };
  const [urgent, pinned] = await Promise.all([
    showUrgent ? listThreads(principal, toListInput(project.id, filters, principal.userId, { ...sectionInput, urgent: true })) : Promise.resolve(null),
    showPinned ? listThreads(principal, toListInput(project.id, filters, principal.userId, { ...sectionInput, pinned: true })) : Promise.resolve(null),
  ]);
  let threads: Awaited<ReturnType<typeof listThreads>> | null = null;
  let listError: string | null = null;
  try {
    threads = await listThreads(principal, toListInput(project.id, filters, principal.userId));
  } catch (error) {
    if (error instanceof DomainError && (error.code === 'invalid_cursor' || error.code === 'validation_failed')) listError = domainMessage(error);
    else throw error;
  }
  const cleared: BoardFilters = { ...filters, cursor: undefined };
  return (
    <div id="board-content" className="space-y-8">
      <a className="underline" href={`${projectPath(slug)}/briefing`}>View agent briefing</a>
      <BoardTabs slug={slug} filters={filters} />
      <details open className="rounded-lg border border-stone-200 bg-white">
        <summary className="cursor-pointer px-4 py-3 font-medium">Filters</summary>
        <div className="px-4 pb-4">
          <Filters slug={slug} filters={filters} agents={agents} />
        </div>
      </details>
      {project.status === 'active' ? (
        <details open className="rounded-lg border border-stone-200 bg-white">
          <summary className="cursor-pointer px-4 py-3 font-medium">New post</summary>
          <div className="px-4 pb-4">
            <RootComposer slug={slug} idempotencyKey={randomUUID()} agents={agents} />
          </div>
        </details>
      ) : null}
      {urgent ? (
        <ThreadSection id="urgent-threads" title="Urgent" empty="No urgent threads." threads={urgent} slug={slug} filters={filters}
          more={{ label: 'More urgent threads', filters: { ...cleared, urgent: true } }} />
      ) : null}
      {pinned ? (
        <ThreadSection id="pinned-threads" title="Pinned" empty="No pinned threads." threads={pinned} slug={slug} filters={filters}
          more={{ label: 'More pinned threads', filters: { ...cleared, pinned: true } }} />
      ) : null}
      {listError ? (
        <div role="alert" className="space-y-2 rounded border p-3">
          <p>{listError}</p>
          <a className="underline" href={`${projectPath(slug)}${boardSearchParams(cleared)}`}>Start again from the first page</a>
        </div>
      ) : threads ? (
        <ThreadSection id="thread-list" title="Threads" slug={slug} filters={filters} threads={threads}
          empty={filtersAreDefault(filters) ? 'No threads yet. Post the first note.' : 'No threads match these filters.'} />
      ) : null}
    </div>
  );
}
