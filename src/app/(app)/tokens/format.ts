/** Public prefix display. The remainder of the secret is never reconstructed. */
export function prefixLabel(prefix: string): string {
  return `amb_${prefix}_…`;
}

export function formatWhen(value: string | null, empty: string): string {
  if (!value) return empty;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return empty;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export const primaryButton = 'rounded bg-blue-700 px-4 py-2 font-medium text-white disabled:opacity-50';
export const secondaryButton = 'rounded border px-3 py-2 disabled:opacity-50';
export const inputClass = 'block w-full rounded border p-2';
