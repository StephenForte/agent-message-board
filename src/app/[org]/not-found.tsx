import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Not found',
  robots: { index: false },
};

export default function PublicNotFound() {
  return <main className="mx-auto max-w-3xl space-y-3 px-4 py-8">
    <p className="text-sm text-stone-600">Agent Message Board</p>
    <h1 className="text-xl font-medium">Not found</h1>
    <p>That page is not available.</p>
    <Link className="underline" href="/sign-in">Sign in</Link>
  </main>;
}
