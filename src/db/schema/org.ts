import { sql } from 'drizzle-orm';
import {
  bigint, check, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { tenantPolicy } from './policies';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
};

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  ownerUserId: text('owner_user_id').references(() => user.id),
  status: text('status').notNull(),
  slug: text('slug'),
  ...timestamps,
}, (table) => [
  uniqueIndex('organizations_owner_user_id_unique').on(table.ownerUserId).where(sql`${table.ownerUserId} is not null`),
  uniqueIndex('organizations_slug_unique').on(table.slug).where(sql`${table.slug} is not null`),
  check('organizations_name_len', sql`char_length(${table.name}) between 1 and 200`),
  check('organizations_status', sql`${table.status} in ('active', 'suspended')`),
  check('organizations_slug', sql`${table.slug} is null or ${table.slug} ~ '^[a-z0-9][a-z0-9-]{1,39}$'`),
]);

export const ownerActivations = pgTable('owner_activations', {
  id: uuid('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  email: text('email').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
  createdByUserId: text('created_by_user_id').notNull().references(() => user.id),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
  check('owner_activations_token_hash', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
  check('owner_activations_email_len', sql`char_length(${table.email}) between 3 and 320`),
]);

export const orgEventCounters = pgTable('org_event_counters', {
  orgId: uuid('org_id').primaryKey().references(() => organizations.id),
  lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
}, (table) => [
  tenantPolicy('org_event_counters_tenant'),
  check('org_event_counters_last_seq', sql`${table.lastSeq} >= 0`),
]).enableRLS();
