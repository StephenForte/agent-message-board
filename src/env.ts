import { z } from 'zod';

const devSecrets = {
  BETTER_AUTH_SECRET: 'obviously-dev-better-auth-secret-do-not-deploy',
  CURSOR_HMAC_SECRET: 'obviously-dev-cursor-hmac-secret-do-not-deploy',
};

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  DATABASE_URL: z.url().refine((value) => /^(postgres|postgresql):\/\//.test(value)),
  BETTER_AUTH_SECRET: z.string().min(32),
  CURSOR_HMAC_SECRET: z.string().min(32),
  APP_BASE_URL: z.url().refine((value) => /^https?:\/\//.test(value)),
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']),
}).superRefine((env, context) => {
  if (env.NODE_ENV !== 'production') return;
  for (const key of ['RESEND_API_KEY', 'EMAIL_FROM'] as const) {
    if (!env[key]?.trim()) context.addIssue({ code: 'custom', path: [key], message: 'Required' });
  }
  for (const key of ['BETTER_AUTH_SECRET', 'CURSOR_HMAC_SECRET'] as const) {
    if (/dev|example|change.?me|placeholder/i.test(env[key])) {
      context.addIssue({ code: 'custom', path: [key], message: 'Production secret required' });
    }
  }
  if (!env.APP_BASE_URL.startsWith('https://')) {
    context.addIssue({ code: 'custom', path: ['APP_BASE_URL'], message: 'HTTPS required' });
  }
});

export type Env = z.infer<typeof schema>;

// Deliberately lazy: Next builds must never need runtime credentials.
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const nodeEnv = source.NODE_ENV ?? 'development';
  const result = schema.safeParse({
    ...source,
    NODE_ENV: nodeEnv,
    LOG_LEVEL: source.LOG_LEVEL ?? 'info',
    ...(nodeEnv !== 'production' ? {
      BETTER_AUTH_SECRET: source.BETTER_AUTH_SECRET ?? devSecrets.BETTER_AUTH_SECRET,
      CURSOR_HMAC_SECRET: source.CURSOR_HMAC_SECRET ?? devSecrets.CURSOR_HMAC_SECRET,
      APP_BASE_URL: source.APP_BASE_URL ?? 'http://localhost:3000',
    } : {}),
  });
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((issue) => issue.path[0]))];
    // Never include Zod issues or supplied values: credentials can be embedded in URLs.
    throw new Error(`Invalid server configuration: ${keys.join(', ')}`);
  }
  return result.data;
}
