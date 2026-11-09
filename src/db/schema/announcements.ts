import { sql, type SQLWrapper } from 'drizzle-orm';
import {
  check, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { organizations } from './org';
import { announcementPolicy } from './policies';

function scopeCheck(scope: SQLWrapper, orgId: SQLWrapper) {
  return sql`((${scope} = 'site' and ${orgId} is null) or (${scope} = 'org' and ${orgId} is not null))`;
}

export const announcements = pgTable('announcements', {
  id: uuid('id').primaryKey(),
  scope: text('scope').notNull(),
  orgId: uuid('org_id').references(() => organizations.id),
  title: text('title').notNull(),
  body: text('body').notNull(),
  version: integer('version').notNull(),
  authorUserId: text('author_user_id').notNull().references(() => user.id),
  clearedAt: timestamp('cleared_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('announcements_one_site').on(table.scope).where(sql`${table.scope} = 'site'`),
  uniqueIndex('announcements_one_org').on(table.orgId).where(sql`${table.scope} = 'org'`),
  announcementPolicy('announcements_tenant'),
  check('announcements_scope', scopeCheck(table.scope, table.orgId)),
  check('announcements_title_len', sql`octet_length(${table.title}) between 1 and 16384`),
  check('announcements_body_len', sql`octet_length(${table.body}) <= 16384`),
  check('announcements_version', sql`${table.version} >= 1`),
]).enableRLS();

export const announcementRevisions = pgTable('announcement_revisions', {
  id: uuid('id').primaryKey(),
  announcementId: uuid('announcement_id').references(() => announcements.id),
  scope: text('scope').notNull(),
  orgId: uuid('org_id').references(() => organizations.id),
  title: text('title').notNull(),
  body: text('body').notNull(),
  version: integer('version').notNull(),
  authorUserId: text('author_user_id').notNull().references(() => user.id),
  clearedAt: timestamp('cleared_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
  unique('announcement_revisions_version').on(table.scope, table.orgId, table.version).nullsNotDistinct(),
  announcementPolicy('announcement_revisions_tenant'),
  check('announcement_revisions_scope', scopeCheck(table.scope, table.orgId)),
  check('announcement_revisions_title_len', sql`octet_length(${table.title}) between 1 and 16384`),
  check('announcement_revisions_body_len', sql`octet_length(${table.body}) <= 16384`),
  check('announcement_revisions_version_min', sql`${table.version} >= 1`),
]).enableRLS();
