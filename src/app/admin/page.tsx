import Link from 'next/link';
import { requireAdmin } from '../../auth/web';
import { relativeTime } from '../../components/board/time';
import { listOrganizationsForAdmin } from '../../domain/organizations';
import { NewOrganizationForm } from './new-form';
import { StatusPill } from './status-pill';

function CreatedAt({ date }: { date: Date }) {
  const iso = date.toISOString();
  const full = new Intl.DateTimeFormat('en', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' }).format(date);
  return <time dateTime={iso} title={full} className="text-xs text-stone-500">{relativeTime(iso)}</time>;
}

export default async function Admin() {
  const principal = await requireAdmin();
  const orgs = await listOrganizationsForAdmin(principal);
  return <div className="min-w-0 space-y-6">
    <h1 id="organizations-heading" className="text-2xl font-semibold text-stone-950">Organizations</h1>
    <section aria-labelledby="new-organization" className="min-w-0 space-y-3 rounded-lg border border-stone-200 bg-white p-4">
      <h2 id="new-organization" className="text-lg font-semibold text-stone-950">New organization</h2>
      <NewOrganizationForm />
    </section>
    {orgs.length === 0 ? <p>No organizations yet.</p> : <ul aria-labelledby="organizations-heading" className="min-w-0 divide-y divide-stone-200 overflow-hidden rounded-lg border border-stone-200 bg-white">
      {orgs.map((org) => <li key={org.id} className="min-w-0 space-y-1 px-3 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <Link href={`/admin/organizations/${org.id}`} className="min-w-0 break-words font-medium text-stone-950 underline">{org.name}</Link>
          <StatusPill status={org.status} />
        </div>
        <p className="break-all text-sm text-stone-700">{org.ownerEmail ?? 'No owner'}</p>
        <p className="text-sm text-stone-700">{org.slug
          ? <Link href={`/${org.slug}`} className="break-all underline">/{org.slug}</Link>
          : 'Not set'}</p>
        <CreatedAt date={org.createdAt} />
      </li>)}
    </ul>}
  </div>;
}
