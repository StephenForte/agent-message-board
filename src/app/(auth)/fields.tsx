export function Field({ name, label, type = 'text', value, autoComplete }: {
  name: string; label: string; type?: string; value?: string; autoComplete?: React.ComponentProps<'input'>['autoComplete'];
}) {
  return <label className="block space-y-1">{label}<input className="block w-full rounded border p-2"
    name={name} type={type} defaultValue={value} required maxLength={type === 'password' ? 128 : 320}
    minLength={type === 'password' ? 8 : undefined}
    autoComplete={autoComplete ?? (type === 'password' ? 'current-password' : name === 'email' ? 'email' : name)} /></label>;
}
export const buttonClass = 'rounded bg-blue-700 px-4 py-2 font-medium text-white disabled:opacity-50';
const messages: Record<string, string> = {
  'rate-limited': 'Too many attempts. Wait a moment before trying again.',
  'session-expired': 'Your session has expired or you are signed out. Please sign in again.',
  'verify-required': 'Verify your email before signing in. Check your inbox for a verification link.',
  'sign-in-failed': 'Unable to sign in. Check your email and password, then try again.',
  'sign-up-failed': 'Unable to create an account. Check your details or try signing in.',
  'verification-sent': 'Check your inbox for a verification link. Verify your email, then sign in.',
  'reset-sent': 'If this email has an account, a password reset link has been sent.',
  'request-failed': 'Unable to send the request. Please try again.',
  'reset-invalid': 'This reset link is invalid or expired. Request a new one.',
  'password-updated': 'Your password has been updated. Sign in with your new password.',
  'activation-failed': 'Activation failed. Use the invited, verified email and a current, unused link. A user can own only one organization.',
};
export function Notice({ code }: { code?: string }) {
  return code && messages[code] ? <p role="status" className="rounded border p-3">{messages[code]}</p> : null;
}
