import { sql, type SQL } from 'drizzle-orm';
import { pgPolicy } from 'drizzle-orm/pg-core';

/** Tenant match. A missing or blank app.org_id matches no rows (fail closed). */
export function orgMatch(): SQL {
  return sql`org_id = NULLIF(current_setting('app.org_id', true), '')::uuid`;
}

export function tenantPolicy(name: string) {
  return pgPolicy(name, {
    for: 'all',
    using: orgMatch(),
    withCheck: orgMatch(),
  });
}

/**
 * Token rows are visible in their org, or — only when no org is set — by an
 * exact prefix. The prefix arm is the bootstrap path used by withTokenLookupTx.
 * Inserts and updates still require the org setting, so a prefix cannot write.
 */
export function tokenBootstrapPolicy() {
  return pgPolicy('agent_tokens_tenant', {
    for: 'all',
    using: sql`(
      org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
      OR (
        NULLIF(current_setting('app.org_id', true), '') IS NULL
        AND prefix = NULLIF(current_setting('app.token_prefix', true), '')
      )
    )`,
    withCheck: orgMatch(),
  });
}

/**
 * Site announcements are readable from any org context and writable only when
 * withSiteAdminTx has set app.site_admin. With no org setting and no site-admin
 * flag, zero rows match. Org rows never match another org.
 */
export function announcementPolicy(name: string) {
  return pgPolicy(name, {
    for: 'all',
    using: sql`(
      (
        NULLIF(current_setting('app.org_id', true), '') IS NOT NULL
        AND (
          scope = 'site'
          OR org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
        )
      )
      OR (
        current_setting('app.site_admin', true) = '1'
        AND scope = 'site'
      )
    )`,
    withCheck: sql`(
      (
        scope = 'org'
        AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
      )
      OR (
        scope = 'site'
        AND org_id IS NULL
        AND current_setting('app.site_admin', true) = '1'
      )
    )`,
  });
}
