export function StatusPill({ status }: { status: string }) {
  const suspended = status === 'suspended';
  const label = suspended ? 'Suspended' : 'Active';
  const tone = suspended
    ? 'border-stone-700 bg-stone-800 text-white'
    : 'border-stone-300 bg-white text-stone-800';
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>;
}
