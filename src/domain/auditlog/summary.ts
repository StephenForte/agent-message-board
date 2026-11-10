export function actorLabel(kind: string, name: string | null, tokenPrefix: string | null): string {
  if (kind === 'human') return name ? `Human, ${name}` : 'Human';
  if (kind === 'agent') {
    const who = name ? `Agent ${name}` : 'Agent';
    return tokenPrefix ? `${who}, token ${tokenPrefix}` : who;
  }
  return 'System';
}

export function summarizeChange(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
  if (keys.length === 0) return 'No field changes recorded.';
  const text = keys.map((key) => {
    const left = before && Object.prototype.hasOwnProperty.call(before, key) ? JSON.stringify(before[key]) : 'empty';
    const right = after && Object.prototype.hasOwnProperty.call(after, key) ? JSON.stringify(after[key]) : 'empty';
    return left === right ? `${key}: ${right}` : `${key}: ${left} to ${right}`;
  }).join('; ');
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}
