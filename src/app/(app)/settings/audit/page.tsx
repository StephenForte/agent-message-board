import Link from 'next/link';
import { DomainError } from '../../../../domain/kernel';
import { listAuditLog, type AuditLogPage } from '../../../../domain/auditlog';
import { ownerPrincipal, raiseDomain } from '../../session';

export const dynamic = 'force-dynamic';

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ cursor?: string; session?: string }> }) {
  const principal = await ownerPrincipal();
  const query = await searchParams;
  const includeSessionSeen = query.session === '1';
  const cursor = query.cursor;
  let page: AuditLogPage | null = null;
  let staleCursor = false;
  try {
    page = await listAuditLog(principal, { cursor, limit: 50, includeSessionSeen });
  } catch (error) {
    if (error instanceof DomainError && error.code === 'invalid_cursor') staleCursor = true;
    else raiseDomain(error);
  }
  const href = (next: { cursor?: string | null; session: boolean }) => {
    const params = new URLSearchParams();
    if (next.session) params.set('session', '1');
    if (next.cursor) params.set('cursor', next.cursor);
    const text = params.toString();
    return text ? `/settings/audit?${text}` : '/settings/audit';
  };
  return <div className="space-y-4">
    <div className="flex flex-wrap items-baseline justify-between gap-4">
      <h1 className="text-2xl font-semibold">Audit log</h1>
      <Link href={href({ session: !includeSessionSeen })} className="underline">
        {includeSessionSeen ? 'Hide session activity' : 'Show session activity'}
      </Link>
    </div>
    <p>{includeSessionSeen ? 'Session activity is included. Each agent call records one session row.' : 'Session activity is hidden. Each agent call records one session row, and those rows are omitted here.'}</p>
    {staleCursor ? <p role="alert">This audit page link is out of date. <Link href={href({ session: includeSessionSeen })} className="underline">Start from the newest records.</Link></p> : null}
    {page && page.items.length === 0 ? <p>No audit records yet.</p> : null}
    {page && page.items.length > 0 ? <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">Audit log</caption>
        <thead><tr>
          <th className="border-b p-2">Time</th>
          <th className="border-b p-2">Actor</th>
          <th className="border-b p-2">Action</th>
          <th className="border-b p-2">Entity</th>
          <th className="border-b p-2">Change</th>
        </tr></thead>
        <tbody>{page.items.map((entry) => <tr key={entry.id}>
          <td className="border-b p-2 align-top">{entry.createdAt}</td>
          <td className="border-b p-2 align-top">{entry.actorLabel}</td>
          <td className="border-b p-2 align-top">{entry.action}</td>
          <td className="border-b p-2 align-top">{entry.entityType} {entry.entityId}</td>
          <td className="border-b p-2 align-top">{entry.summary}</td>
        </tr>)}</tbody>
      </table>
    </div> : null}
    {page?.nextCursor ? <Link href={href({ cursor: page.nextCursor, session: includeSessionSeen })} className="underline">Older records</Link> : null}
  </div>;
}
