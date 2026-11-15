import { sql, type SQLWrapper } from 'drizzle-orm';
import {
  check, foreignKey, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { projects } from './projects';
import { organizations } from './org';
import { announcementPolicy } from './policies';

function scopeCheck(scope: SQLWrapper, orgId: SQLWrapper, projectId: SQLWrapper) {
  return sql`((${scope} = 'site' and ${orgId} is null and ${projectId} is null) or (${scope} = 'org' and ${orgId} is not null and ${projectId} is null) or (${scope} = 'project' and ${orgId} is not null and ${projectId} is not null))`;
}

export const announcements = pgTable('announcements', {
  id: uuid('id').primaryKey(),
  scope: text('scope').notNull(),
  orgId: uuid('org_id').references(() => organizations.id),
  projectId: uuid('project_id'),
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
  uniqueIndex('announcements_one_project').on(table.projectId).where(sql`${table.scope} = 'project'`),
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id] }),
  ...announcementPolicy('announcements_tenant'),
  check('announcements_scope', scopeCheck(table.scope, table.orgId, table.projectId)),
  check('announcements_title_len', sql`octet_length(${table.title}) between 1 and 16384`),
  check('announcements_body_len', sql`octet_length(${table.body}) <= 16384`),
  check('announcements_version', sql`${table.version} >= 1`),
]).enableRLS();

export const announcementRevisions = pgTable('announcement_revisions', {
  id: uuid('id').primaryKey(),
  announcementId: uuid('announcement_id').references(() => announcements.id),
  scope: text('scope').notNull(),
  orgId: uuid('org_id').references(() => organizations.id),
  projectId: uuid('project_id'),
  title: text('title').notNull(),
  body: text('body').notNull(),
  version: integer('version').notNull(),
  authorUserId: text('author_user_id').notNull().references(() => user.id),
  clearedAt: timestamp('cleared_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
  unique('announcement_revisions_version').on(table.scope, table.orgId, table.projectId, table.version).nullsNotDistinct(),
  foreignKey({ columns: [table.orgId, table.projectId], foreignColumns: [projects.orgId, projects.id] }),
  ...announcementPolicy('announcement_revisions_tenant'),
  check('announcement_revisions_scope', scopeCheck(table.scope, table.orgId, table.projectId)),
  check('announcement_revisions_title_len', sql`octet_length(${table.title}) between 1 and 16384`),
  check('announcement_revisions_body_len', sql`octet_length(${table.body}) <= 16384`),
  check('announcement_revisions_version_min', sql`${table.version} >= 1`),
]).enableRLS();
