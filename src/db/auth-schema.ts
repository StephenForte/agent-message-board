import { account, session, user, verification } from './schema/auth';

/** Tables the Better Auth Drizzle adapter addresses by model name. */
export const betterAuthSchema = { user, session, account, verification };

/**
 * Pass this as the second argument to `drizzleAdapter(db, betterAuthDrizzleConfig)`.
 * camelCase stays at the adapter default (false): SQL names are snake_case and the
 * Drizzle property names are camelCase, which is what better-auth 1.7.18 looks up.
 */
export const betterAuthDrizzleConfig = {
  provider: 'pg' as const,
  schema: betterAuthSchema,
};

export { account, session, user, verification };
