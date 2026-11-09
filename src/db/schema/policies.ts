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
 * exact prefix. The prefix arm is SELECT-only (withTokenLookupTx). Insert,
 * update, and delete require the org setting, so a prefix cannot write or
 * delete the matched token. PostgreSQL applies USING to DELETE; a FOR ALL
 * policy would have let the prefix arm delete.
 */
export function tokenBootstrapPolicy() {
  const prefixSelect = sql`(
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    OR (
      NULLIF(current_setting('app.org_id', true), '') IS NULL
      AND prefix = NULLIF(current_setting('app.token_prefix', true), '')
    )
  )`;
  return [
    pgPolicy('agent_tokens_select', { for: 'select', using: prefixSelect }),
    pgPolicy('agent_tokens_insert', { for: 'insert', withCheck: orgMatch() }),
    pgPolicy('agent_tokens_update', { for: 'update', using: orgMatch(), withCheck: orgMatch() }),
    pgPolicy('agent_tokens_delete', { for: 'delete', using: orgMatch() }),
  ];
}

/**
 * Site announcements are readable from any org context. Writes are a separate
 * policy: DELETE and UPDATE consult USING, and a FOR ALL policy would let a
 * tenant delete a site row or rewrite it into their org. Site writes require
 * app.site_admin (withSiteAdminTx). With no org setting and no site-admin
 * flag, zero rows match. Org rows never match another org.
 */
export function announcementPolicy(name: string) {
  const read = sql`(
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
  )`;
  const write = sql`(
    (
      scope = 'org'
      AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    )
    OR (
      scope = 'site'
      AND org_id IS NULL
      AND current_setting('app.site_admin', true) = '1'
    )
  )`;
  return [
    pgPolicy(`${name}_select`, { for: 'select', using: read }),
    pgPolicy(`${name}_insert`, { for: 'insert', withCheck: write }),
    pgPolicy(`${name}_update`, { for: 'update', using: write, withCheck: write }),
    pgPolicy(`${name}_delete`, { for: 'delete', using: write }),
  ];
}
