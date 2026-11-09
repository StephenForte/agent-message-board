import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { getDb, type AppDatabase } from '../db/client';
import { betterAuthDrizzleConfig } from '../db/auth-schema';
import { loadEnv, type Env } from '../env';
import { ConsoleEmailAdapter, ResendEmailAdapter, type EmailAdapter } from './email';
import { AUTH_BASE_PATH } from './paths';

export function createAuth(database: AppDatabase, env: Env, email?: EmailAdapter) {
  const delivery = email ?? (env.NODE_ENV === 'production'
    ? new ResendEmailAdapter(env.RESEND_API_KEY!, env.EMAIL_FROM!) : new ConsoleEmailAdapter());
  return betterAuth({
    database: drizzleAdapter(database, betterAuthDrizzleConfig),
    baseURL: env.APP_BASE_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [new URL(env.APP_BASE_URL).origin],
    logger: { disabled: true }, // Errors are surfaced without credentials by adapters.
    emailAndPassword: {
      enabled: true, requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => delivery.send({
        to: user.email, subject: 'Reset your password', text: `Reset your password: ${url}`,
      }),
    },
    emailVerification: {
      sendOnSignUp: true, sendOnSignIn: true,
      sendVerificationEmail: async ({ user, url }) => delivery.send({
        to: user.email, subject: 'Verify your email', text: `Verify your email: ${url}`,
      }),
    },
    session: { cookieCache: { enabled: false } },
    advanced: {
      disableCSRFCheck: false, disableOriginCheck: false,
      useSecureCookies: env.NODE_ENV === 'production',
      defaultCookieAttributes: { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax' },
    },
    plugins: [nextCookies()],
  });
}

// Lazy: build needs no database or secrets; tests can inject both DB and email delivery.
export function getAuth() { return createAuth(getDb(), loadEnv()); }
export type Auth = ReturnType<typeof createAuth>;
