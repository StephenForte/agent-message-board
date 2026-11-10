import Link from 'next/link';

export default function NotFound() {
  return <div className="space-y-3">
    <h2 className="text-xl font-medium">Not found</h2>
    <p>That page is not available.</p>
    <Link href="/" className="underline">Back to organization home</Link>
  </div>;
}
