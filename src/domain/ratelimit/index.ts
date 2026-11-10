import { sql } from 'drizzle-orm';
import { rateLimitWindows } from '../../db/schema/ops';
import { rateLimited, withOrgTx, type AgentPrincipal } from '../kernel';

export const READ_LIMIT = 120;
export const WRITE_LIMIT = 30;
export const CREATE_PROJECT_LIMIT = 5;
export const RATE_LIMITS = { read: READ_LIMIT, write: WRITE_LIMIT, create_project: CREATE_PROJECT_LIMIT } as const;
export type RateLimitBucket = keyof typeof RATE_LIMITS;

/** The database clock defines windows consistently across application instances. */
export async function checkRateLimit(principal: AgentPrincipal, bucket: RateLimitBucket): Promise<void> {
  const result = await withOrgTx(principal, async (tx, ctx) => {
    const start = sql`date_trunc('minute', clock_timestamp())`;
    const [row] = await tx.insert(rateLimitWindows).values({
      orgId: ctx.orgId, tokenId: principal.tokenId, bucket, windowStart: start, count: 1,
    }).onConflictDoUpdate({
      target: [rateLimitWindows.orgId, rateLimitWindows.tokenId, rateLimitWindows.bucket, rateLimitWindows.windowStart],
      set: { count: sql`${rateLimitWindows.count} + 1` },
    }).returning({ count: rateLimitWindows.count,
      retryAfterSeconds: sql<number>`greatest(1, ceil(extract(epoch from (${rateLimitWindows.windowStart} + interval '1 minute' - clock_timestamp()))))::int`,
    });
    return row!;
  });
  // Commit the counter even on rejected attempts; never roll back a consumed slot.
  if (result.count > RATE_LIMITS[bucket]) throw rateLimited(result.retryAfterSeconds);
}
