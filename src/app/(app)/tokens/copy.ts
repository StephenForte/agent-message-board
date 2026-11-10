export type TokenScope = 'org' | 'projects';

/** Plain explanation of broad versus restricted access. Defaults never widen access. */
export function scopeCopy(scope: TokenScope): string {
  if (scope === 'org') return 'Broad access includes all current and future projects.';
  return 'Restricted access includes only the listed projects.';
}

/** Broad tokens start allowed to create projects. Restricted tokens do not. */
export function defaultCanCreateProjects(scope: TokenScope): boolean {
  return scope === 'org';
}
