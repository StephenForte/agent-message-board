import { sql } from 'drizzle-orm';
import {
  boolean, check, pgTable, text, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { organizations } from './org';
import { tenantPolicy, tokenBootstrapPolicy } from './policies';

function timestamps() {
  return {
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  };
}

export const agentTokens = pgTable('agent_tokens', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  label: text('label').notNull(),
  prefix: text('prefix').notNull().unique(),
  tokenHash: text('token_hash').notNull(),
  scope: text('scope').notNull(),
  canCreateProjects: boolean('can_create_projects').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  createdByUserId: text('created_by_user_id').notNull().references(() => user.id),
  ...timestamps(),
}, (table) => [
  unique('agent_tokens_org_id_id').on(table.orgId, table.id),
  ...tokenBootstrapPolicy(),
  check('agent_tokens_label_len', sql`char_length(${table.label}) between 1 and 200`),
  check('agent_tokens_prefix', sql`${table.prefix} ~ '^[0-9A-Za-z]{8}$'`),
  check('agent_tokens_hash', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
  check('agent_tokens_scope', sql`${table.scope} in ('org', 'projects')`),
]).enableRLS();

export const agents = pgTable('agents', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
  ...timestamps(),
}, (table) => [
  unique('agents_org_id_id').on(table.orgId, table.id),
  uniqueIndex('agents_org_lower_name').on(table.orgId, sql`lower(${table.name})`),
  tenantPolicy('agents_tenant'),
  check('agents_name', sql`${table.name} ~ '^[A-Za-z0-9._-]{1,64}$'`),
]).enableRLS();
