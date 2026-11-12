import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAdmin } from '../../../../auth/web';
import { listOrganizationsForAdmin } from '../../../../domain/organizations';
import { loadEnv } from '../../../../env';
import { StatusPill } from '../../status-pill';
import { OwnerPanel, PublicAddressForm, StatusSection } from './forms';

function publicAddress(slug: string): string {
  return new URL(`/${slug}`, loadEnv().APP_BASE_URL).toString();
}

export default async function OrganizationAdminPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireAdmin();
  const { id } = await params;
  const org = (await listOrganizationsForAdmin(principal)).find((item) => item.id === id);
  if (!org) notFound();
  const status = org.status === 'suspended' ? 'suspended' : 'active';
  const address = org.slug ? publicAddress(org.slug) : null;
  return <div className="min-w-0 space-y-6">
    <p><Link href="/admin" className="text-sm text-stone-700 underline">Back to organizations</Link></p>
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <h1 className="min-w-0 break-words text-2xl font-semibold text-stone-950">{org.name}</h1>
      <StatusPill status={status} />
    </div>
    <section aria-labelledby="owner-heading" className="min-w-0 space-y-3 rounded-lg border border-stone-200 bg-white p-4">
      <h2 id="owner-heading" className="text-lg font-semibold text-stone-950">Owner</h2>
      <OwnerPanel key={org.id} id={org.id} ownerEmail={org.ownerEmail} />
    </section>
    <section aria-labelledby="address-heading" className="min-w-0 space-y-3 rounded-lg border border-stone-200 bg-white p-4">
      <h2 id="address-heading" className="text-lg font-semibold text-stone-950">Public address</h2>
      {address ? <a href={address} className="block break-all underline">{address}</a> : <p>Not set</p>}
      <PublicAddressForm key={org.id} id={org.id} slug={org.slug} />
    </section>
    <section aria-labelledby="status-heading" className="min-w-0 space-y-3 rounded-lg border border-stone-200 bg-white p-4">
      <h2 id="status-heading" className="text-lg font-semibold text-stone-950">Status</h2>
      <StatusSection key={org.id} id={org.id} status={status} />
    </section>
  </div>;
}
