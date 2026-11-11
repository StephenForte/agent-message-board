const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const delta = now - then;
  const abs = Math.abs(delta);
  const suffix = delta < 0 ? 'from now' : 'ago';
  if (abs < MINUTE) return 'just now';
  if (abs < HOUR) return `${Math.floor(abs / MINUTE)} m ${suffix}`;
  if (abs < DAY) return `${Math.floor(abs / HOUR)} h ${suffix}`;
  if (abs < 30 * DAY) return `${Math.floor(abs / DAY)} d ${suffix}`;
  return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(then));
}

export function TimeStamp({ iso, className }: { iso: string; className?: string }) {
  return <time dateTime={iso} title={iso} className={className}>{relativeTime(iso)}</time>;
}
