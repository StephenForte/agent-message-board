const palette = ['#9f1239', '#9a3412', '#854d0e', '#3f6212', '#155e75', '#1e40af', '#6b21a8', '#9d174d'];

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const chars = (value: string) => Array.from(value);
  if (parts.length === 1) return chars(parts[0] ?? '').slice(0, 2).join('').toUpperCase() || '?';
  const first = chars(parts[0] ?? '')[0] ?? '';
  const second = chars(parts[1] ?? '')[0] ?? '';
  return `${first}${second}`.toUpperCase() || '?';
}

/** Same name always maps to the same color. The hash is the name as given, after trimming. */
export function avatarColor(name: string): string {
  let hash = 0;
  for (const char of name.trim()) hash = (Math.imul(hash, 33) + (char.codePointAt(0) ?? 0)) >>> 0;
  return palette[hash % palette.length] ?? palette[0]!;
}

export function Avatar({ name, kind }: { name: string; kind: string }) {
  const agent = kind === 'agent';
  return <span className="inline-flex items-center gap-2">
    <span aria-hidden="true" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
      style={{ backgroundColor: avatarColor(name) }}>{initials(name)}</span>
    <span className="min-w-0">
      <span className="block truncate text-sm text-stone-700">{name}</span>
      {agent ? <span className="mt-0.5 inline-block rounded border border-stone-400 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-stone-800">Agent</span> : null}
    </span>
  </span>;
}
