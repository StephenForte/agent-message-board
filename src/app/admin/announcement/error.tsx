'use client';

export default function SiteAnnouncementError({ reset }: { error: Error; reset: () => void }) {
  return <div role="alert" className="space-y-3">
    <h2 className="text-xl font-medium">This page could not be loaded.</h2>
    <p>Try again. If the board is unavailable, the site announcement was not changed.</p>
    <button type="button" onClick={reset} className="rounded border px-3 py-2">Try again</button>
  </div>;
}
