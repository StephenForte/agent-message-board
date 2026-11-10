import Link from 'next/link';
import { ownerPrincipal } from '../session';

export const dynamic = 'force-dynamic';

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await ownerPrincipal();
  return <div className="space-y-6">
    <nav aria-label="Settings" className="flex gap-4">
      <Link href="/settings" className="underline">Announcement</Link>
      <Link href="/settings/audit" className="underline">Audit log</Link>
    </nav>
    {children}
  </div>;
}
