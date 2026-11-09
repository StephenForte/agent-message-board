import { cookies, headers } from 'next/headers';
import { parseSetCookieHeader, toCookieOptions } from 'better-auth/cookies';
import { getAuth } from './index';
import { loadEnv } from '../env';
import { AUTH_BASE_PATH } from './paths';
import { notFound, redirect } from 'next/navigation';
import { getHumanPrincipal } from './principal';
import { listOrganizationsForAdmin } from '../domain/organizations';
import { DomainError } from '../domain/kernel';

export async function requireHuman() {
  const principal = await getHumanPrincipal(await headers());
  if (!principal) redirect('/sign-in?message=session-expired');
  return principal;
}
export async function requireAdmin() {
  const principal = await getHumanPrincipal(await headers());
  try { await listOrganizationsForAdmin(principal); }
  catch (error) {
    if (error instanceof DomainError && error.code === 'forbidden_or_not_found') notFound();
    throw error;
  }
  if (!principal) notFound();
  return principal;
}
export function safeActivationReturn(value: unknown): string | null {
  return typeof value === 'string' && /^\/activate\/[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export class AuthActionError extends Error {
  constructor(readonly code: string) { super('Authentication request failed'); }
}
/** Use the HTTP handler in server actions so Better Auth's default rate limiter also runs. */
export async function performAuth(path: string, body: Record<string, unknown>) {
  const incoming = await headers();
  const forwarded = new Headers(incoming);
  forwarded.set('content-type', 'application/json');
  forwarded.delete('content-length');
  const response = await getAuth().handler(new Request(`${loadEnv().APP_BASE_URL}${AUTH_BASE_PATH}${path}`, {
    method: 'POST', headers: forwarded, body: JSON.stringify(body),
  }));
  const cookieStore = await cookies();
  for (const [name, value] of parseSetCookieHeader(response.headers.get('set-cookie') ?? '')) {
    cookieStore.set(name, value.value, toCookieOptions(value));
  }
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new AuthActionError(response.status === 429 ? 'RATE_LIMITED' : typeof result.code === 'string' ? result.code : 'AUTH_FAILED');
  }
}
