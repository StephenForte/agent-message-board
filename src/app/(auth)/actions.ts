'use server';
import { redirect } from 'next/navigation';
import { requireHuman, safeActivationReturn, performAuth, AuthActionError } from '../../auth/web';
import { consumeOwnerActivation, humanLanding } from '../../domain/organizations';
import { DomainError } from '../../domain/kernel';

const text = (data: FormData, key: string) => String(data.get(key) ?? '');
const back = (data: FormData) => safeActivationReturn(data.get('returnTo'));
function failure(path: string, code: string, returnTo?: string | null): never {
  const query = new URLSearchParams({ message: code });
  if (returnTo) query.set('returnTo', returnTo);
  redirect(`${path}?${query}`);
}
export async function signIn(data: FormData) {
  try {
    await performAuth('/sign-in/email', {
      email: text(data, 'email'), password: text(data, 'password'),
    });
  } catch (error) {
    failure('/sign-in', error instanceof AuthActionError && error.code === 'EMAIL_NOT_VERIFIED'
      ? 'verify-required' : error instanceof AuthActionError && error.code === 'RATE_LIMITED'
        ? 'rate-limited' : 'sign-in-failed', back(data));
  }
  const next = back(data);
  redirect(next ?? '/auth-complete');
}
export async function signUp(data: FormData) {
  try {
    await performAuth('/sign-up/email', {
      name: text(data, 'name'), email: text(data, 'email'), password: text(data, 'password'),
      callbackURL: '/verify-email',
    });
  } catch { failure('/sign-up', 'sign-up-failed', back(data)); }
  failure('/verify-email', 'verification-sent', back(data));
}
export async function forgotPassword(data: FormData) {
  try { await performAuth('/request-password-reset', {
    email: text(data, 'email'), redirectTo: '/reset-password',
  }); } catch { failure('/forgot-password', 'request-failed'); }
  failure('/forgot-password', 'reset-sent');
}
export async function resetPassword(data: FormData) {
  try { await performAuth('/reset-password', {
    newPassword: text(data, 'password'), token: text(data, 'token'),
  }); } catch { failure('/forgot-password', 'reset-invalid'); }
  failure('/sign-in', 'password-updated');
}
export async function signOut() {
  await performAuth('/sign-out', {});
  redirect('/sign-in');
}
export async function activate(data: FormData) {
  const principal = await requireHuman();
  try { await consumeOwnerActivation(principal, text(data, 'token')); }
  catch (error) {
    if (!(error instanceof DomainError)) throw error;
    // Do not echo the credential into the redirect/error URL.
    failure('/no-organization', 'activation-failed');
  }
  redirect(await humanLanding(principal));
}
