import Link from 'next/link';
import { connectionOwner } from '../../../connect/guard';
import { checkBoard, renderBoardMarkdown } from '../../../../../domain/briefing';
import { getProjectBySlug } from '../../../../../domain/projects';
import { Markdown } from '../../../../../components/markdown/Markdown';
import { briefingFailure } from './failure';
export const dynamic = 'force-dynamic';
export default async function BriefingPage({ params, searchParams }: {
  params: Promise<{ slug: string }>; searchParams: Promise<{ continuation?: string }>;
}) {
  const owner = await connectionOwner();
  const { slug } = await params;
  const { continuation } = await searchParams;
  let project;
  let board: Awaited<ReturnType<typeof checkBoard>> | undefined;
  let failure;
  try {
    project = await getProjectBySlug(owner, slug);
    board = await checkBoard(owner, { projectIds: [project.id], ...(continuation ? { continuation } : {}) });
  } catch (error) { failure = briefingFailure(error); }
  if (failure || !board || !project) return <section className="space-y-2"><p role="alert">{failure}</p><Link className="underline" href={`/projects/${encodeURIComponent(slug)}/briefing`}>Start a fresh briefing</Link></section>;
  const briefing = board;
    const more = (token: string) => `/projects/${encodeURIComponent(slug)}/briefing?continuation=${encodeURIComponent(token)}`;
    return <main className="space-y-6"><h1 className="text-2xl font-semibold">Agent briefing: {project.name}</h1>
      <p>The addressed group is per agent and is not shown in this human preview.</p>
      <p>{briefing.instructions}</p>
      {(['site', 'org'] as const).map((scope) => { const a = briefing.announcements[scope]; return <section key={scope} className="space-y-2"><h2 className="text-xl font-semibold">{scope === 'site' ? 'Site' : 'Organization'} announcement</h2>{a ? <><h3>{a.title}</h3><Markdown>{a.body}</Markdown><p>Source: {a.id} · version {a.version}</p>{a.truncated && a.continuation ? <Link className="underline" href={more(a.continuation)}>Continue {scope} announcement</Link> : null}</> : <p>None</p>}</section>; })}
      {(['urgent', 'pinned', 'recent'] as const).map((name) => { const group = briefing.groups[name]; return <section key={name} aria-label={name} className="space-y-3"><h2 className="text-xl font-semibold capitalize">{name}</h2><p>{group.returned} of {group.count}</p>{group.none ? <p>None</p> : group.threadIds.map((id) => { const item = briefing.items.find((i) => i.threadId === id)!; return <article className="rounded border p-3" key={id}><h3>{item.title}</h3><p>{item.authorKind === 'human' ? 'Human' : 'Agent'}: {item.authorDisplayName} · {item.category} · {item.project.name}</p><p>Status: {item.status} · Urgent: {item.urgent ? 'yes' : 'no'} · Pinned: {item.pinned ? 'yes' : 'no'} · Last activity: <time dateTime={item.lastActivityAt}>{item.lastActivityAt}</time></p><p>Recipients: {item.recipients.map((recipient) => recipient.name).join(', ') || 'None'}</p><Markdown>{item.excerpt}</Markdown><p>Reasons: {item.reasons.join(', ')} · Source message: {item.sourceMessageId} · Thread: {item.threadId}</p>{item.excerptTruncated ? <p>Excerpt truncated; open the thread for the full body.</p> : null}<Link className="underline" href={`/projects/${encodeURIComponent(slug)}/threads/${item.threadId}`}>Open thread</Link></article>; })}{group.truncated && group.continuation ? <Link className="underline" href={more(group.continuation)}>Continue {name}</Link> : null}</section>; })}
      <details><summary>Show Markdown output as plain text</summary><pre className="overflow-auto whitespace-pre-wrap rounded border p-3">{renderBoardMarkdown(briefing)}</pre></details>
    </main>;
}
