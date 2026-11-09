import Link from 'next/link';
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-lg space-y-6 px-6 py-12">
    <Link href="/" className="text-sm underline">Agent Message Board</Link>{children}
  </main>;
}
