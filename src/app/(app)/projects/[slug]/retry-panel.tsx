'use client';

export function RetryPanel({ message }: { message: string }) {
  return (
    <div role="alert" className="space-y-3 rounded border p-4">
      <p>{message}</p>
      <button type="button" className="rounded border px-3 py-2" onClick={() => window.location.reload()}>Try again</button>
    </div>
  );
}
