const labels: Record<string, string> = {
  note: 'Note',
  finding: 'Finding',
  decision: 'Decision',
  blocker: 'Blocker',
  handoff: 'Handoff',
};

export function categoryLabel(category: string): string {
  return labels[category] ?? category;
}

export function CategoryPill({ category }: { category: string }) {
  return <span className="inline-flex items-center rounded-full border border-stone-300 bg-white px-2 py-0.5 text-xs font-medium text-stone-800">{categoryLabel(category)}</span>;
}

export function FlagPill({ children }: { children: string }) {
  return <span className="inline-flex items-center rounded-full border border-stone-700 bg-stone-800 px-2 py-0.5 text-xs font-medium text-white">{children}</span>;
}
