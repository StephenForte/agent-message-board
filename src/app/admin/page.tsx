import { requireAdmin } from '../../auth/web';
import { listOrganizationsForAdmin } from '../../domain/organizations';
import { AdminForm } from './form';
export default async function Admin() {
  const principal = await requireAdmin(); const orgs = await listOrganizationsForAdmin(principal);
  return <><h1 className="text-2xl font-semibold">Organizations</h1><AdminForm operation="create" />
    {orgs.length === 0 && <p>No organizations yet.</p>}
    <ul className="space-y-6">{orgs.map((org) => <li key={org.id} className="space-y-3 rounded border p-4">
      <h2 className="text-xl font-medium">{org.name}</h2><p>{org.status} · {org.ownerEmail ?? 'No owner'} · Created {org.createdAt.toISOString()}</p>
      <AdminForm operation="associate" id={org.id} />{!org.ownerEmail && <AdminForm operation="activate" id={org.id} />}
      <AdminForm operation={org.status === 'active' ? 'suspend' : 'restore'} id={org.id} />
    </li>)}</ul></>;
}
