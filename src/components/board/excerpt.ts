const EXCERPT_CHARACTERS = 180;

/** Plain-text preview. Markdown is not parsed, so a row never contains nested links. */
export function excerptText(value: string, max = EXCERPT_CHARACTERS): string {
  const plain = value.replace(/\s+/g, ' ').trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, Math.max(0, max - 1)).trimEnd();
  return `${cut}…`;
}
