import Link from 'next/link';
import { requireOrgOwnerPage } from '../session';

export const dynamic = 'force-dynamic';

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requireOrgOwnerPage();
  return <div className="space-y-6">
    <nav aria-label="Settings" className="flex gap-4">
      <Link href="/settings" className="underline">Announcement</Link>
      <Link href="/settings/audit" className="underline">Audit log</Link>
      <Link href="/settings/members" className="underline">Members</Link>
    </nav>
    {children}
  </div>;
}
