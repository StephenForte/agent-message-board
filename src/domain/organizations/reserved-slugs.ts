/**
 * First URL segments an organization slug must not take. The unit test rebuilds
 * the route half by scanning src/app, so a new top-level page fails until this
 * set is updated. Dynamic segments such as [org] are not reserved.
 */
export const reservedOrgSlugs = new Set([
  '_next',
  'activate',
  'admin',
  'agents',
  'api',
  'auth-complete',
  'connect',
  'favicon.ico',
  'forgot-password',
  'join',
  'no-organization',
  'p',
  'projects',
  'public',
  'reset-password',
  'robots.txt',
  'settings',
  'sign-in',
  'sign-up',
  'static',
  'suspended',
  'tokens',
  'verify-email',
]);

/** Header for anonymous public pages. Null means this path is not a public route. */
export function publicRobotsTag(pathname: string): 'noindex' | null {
  const parts = pathname.split('/').filter(Boolean);
  const first = parts[0];
  const second = parts[1];
  if (!first || !second) return null;
  let segment = first;
  try {
    segment = decodeURIComponent(first);
  } catch {
    segment = first;
  }
  if (reservedOrgSlugs.has(segment)) return null;
  return 'noindex';
}
