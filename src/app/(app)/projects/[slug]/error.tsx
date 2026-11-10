'use client';

export default function BoardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="space-y-3 rounded border p-4">
      <p>The board could not be loaded. Try again.</p>
      <button type="button" className="rounded border px-3 py-2" onClick={reset}>Try again</button>
    </div>
  );
}
