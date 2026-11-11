import { excerptText } from './excerpt';
import { Avatar } from './avatar';
import { CategoryPill, FlagPill } from './pills';
import { TimeStamp } from './time';

export type ThreadRowModel = {
  id: string;
  href: string;
  title: string;
  excerpt: string;
  replyCount: number;
  authorName: string;
  authorKind: string;
  category: string;
  urgent: boolean;
  pinned: boolean;
  lastActivityAt: string;
  projectLabel?: string;
};

export function ThreadList({ children, labelledBy }: { children: React.ReactNode; labelledBy?: string }) {
  return <ul aria-labelledby={labelledBy} className="divide-y divide-stone-200 overflow-hidden rounded-lg border border-stone-200 bg-white">{children}</ul>;
}

export function ThreadRow({ thread, headingId }: { thread: ThreadRowModel; headingId: string }) {
  const excerpt = excerptText(thread.excerpt);
  const replies = thread.replyCount === 1 ? 'Reply' : 'Replies';
  return <a href={thread.href} aria-label={thread.title} className="block px-3 py-3 hover:bg-stone-50">
    <span className="flex items-start gap-3">
      <span className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-md border border-stone-300 bg-stone-50 text-stone-800" aria-hidden="true">
        <span className="text-lg font-semibold leading-none">{thread.replyCount}</span>
        <span className="mt-1 text-[10px] font-medium uppercase tracking-wide">{replies}</span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-start justify-between gap-2" aria-hidden="true">
          <Avatar name={thread.authorName} kind={thread.authorKind} />
          <TimeStamp iso={thread.lastActivityAt} className="text-xs text-stone-500" />
        </span>
        <h3 id={headingId} className="mt-2 break-words text-base font-semibold text-stone-950">{thread.title}</h3>
        {excerpt ? <p className="excerpt-clamp mt-1 text-sm text-stone-600" aria-hidden="true">{excerpt}</p> : null}
        <span className="mt-2 flex flex-wrap items-center gap-1.5" aria-hidden="true">
          {thread.projectLabel ? <span className="inline-flex items-center rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-700">{thread.projectLabel}</span> : null}
          <CategoryPill category={thread.category} />
          {thread.urgent ? <FlagPill>Urgent</FlagPill> : null}
          {thread.pinned ? <FlagPill>Pinned</FlagPill> : null}
        </span>
      </span>
    </span>
  </a>;
}
