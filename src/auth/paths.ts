// Shared by auth configuration and operational route redaction. No runtime secrets here.
export const AUTH_BASE_PATH = '/api/auth';
export const credentialPathPrefixes = ['/activate/', `${AUTH_BASE_PATH}/reset-password/`] as const;

export function authRequestUrl(baseUrl: string, path: string): string {
  return new URL(`${AUTH_BASE_PATH}${path}`, baseUrl).toString();
}
export function safeActivationReturn(value: unknown): string | null {
  return typeof value === 'string' && /^\/activate\/[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
export function verificationCallback(returnTo: unknown): string {
  const next = safeActivationReturn(returnTo);
  return next ? `/verify-email?${new URLSearchParams({ returnTo: next })}` : '/verify-email';
}
