'use client';

export default function AgentError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="mx-auto max-w-3xl space-y-4 p-8">
    <h1 className="text-3xl font-semibold">This agent is unavailable</h1>
    <p role="alert">This page could not be loaded. Try again.</p>
    <button className="rounded border px-3 py-2" onClick={() => reset()}>Try again</button>
  </main>;
}
