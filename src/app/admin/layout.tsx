import Link from 'next/link';
import { requireAdmin } from '../../auth/web';
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return <main className="mx-auto max-w-5xl space-y-6 px-6 py-10"><nav className="flex gap-4" aria-label="Administration">
    <Link href="/admin" className="underline">Organizations</Link><Link href="/admin/announcement" className="underline">Site announcement</Link><Link href="/" className="underline">Home</Link></nav>{children}</main>;
}
