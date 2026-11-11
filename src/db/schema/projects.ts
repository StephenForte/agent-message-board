import { sql } from 'drizzle-orm';
import {
  check, foreignKey, pgTable, primaryKey, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { agentTokens, agents } from './identity';
import { organizations } from './org';
import { tenantPolicy } from './policies';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
};

export const projects = pgTable('projects', {
  id: uuid('id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').notNull(),
  visibility: text('visibility').notNull().default('private'),
  createdByKind: text('created_by_kind').notNull(),
  createdByUserId: text('created_by_user_id').references(() => user.id),
  createdByTokenId: uuid('created_by_token_id'),
  createdByAgentId: uuid('created_by_agent_id'),
  ...timestamps,
}, (table) => [
  primaryKey({ columns: [table.id], name: 'projects_pkey' }),
  unique('projects_org_id_id').on(table.orgId, table.id),
  unique('projects_org_slug').on(table.orgId, table.slug),
  foreignKey({
    name: 'projects_created_by_token_fk',
    columns: [table.orgId, table.createdByTokenId],
    foreignColumns: [agentTokens.orgId, agentTokens.id],
  }),
  foreignKey({
    name: 'projects_created_by_agent_fk',
    columns: [table.orgId, table.createdByAgentId],
    foreignColumns: [agents.orgId, agents.id],
  }),
  tenantPolicy('projects_tenant'),
  check('projects_slug', sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{0,62}$'`),
  check('projects_name_len', sql`char_length(${table.name}) between 1 and 200`),
  check('projects_description_len', sql`${table.description} is null or octet_length(${table.description}) <= 8192`),
  check('projects_status', sql`${table.status} in ('active', 'archived')`),
  check('projects_visibility', sql`${table.visibility} in ('private', 'public')`),
  check('projects_creator', sql`(
    (${table.createdByKind} = 'human'
      and ${table.createdByUserId} is not null
      and ${table.createdByTokenId} is null
      and ${table.createdByAgentId} is null)
    or
    (${table.createdByKind} = 'agent'
      and ${table.createdByUserId} is null
      and ${table.createdByTokenId} is not null
      and ${table.createdByAgentId} is not null)
  )`),
]).enableRLS();

export const tokenProjectGrants = pgTable('token_project_grants', {
  orgId: uuid('org_id').notNull(),
  tokenId: uuid('token_id').notNull(),
  projectId: uuid('project_id').notNull(),
  source: text('source').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.orgId, table.tokenId, table.projectId], name: 'token_project_grants_pkey' }),
  foreignKey({
    name: 'token_project_grants_token_fk',
    columns: [table.orgId, table.tokenId],
    foreignColumns: [agentTokens.orgId, agentTokens.id],
  }),
  foreignKey({
    name: 'token_project_grants_project_fk',
    columns: [table.orgId, table.projectId],
    foreignColumns: [projects.orgId, projects.id],
  }),
  tenantPolicy('token_project_grants_tenant'),
  check('token_project_grants_source', sql`${table.source} in ('owner', 'agent_create')`),
]).enableRLS();

export const agentProjectDefaults = pgTable('agent_project_defaults', {
  orgId: uuid('org_id').notNull(),
  agentId: uuid('agent_id').notNull(),
  projectId: uuid('project_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.orgId, table.agentId, table.projectId], name: 'agent_project_defaults_pkey' }),
  foreignKey({
    name: 'agent_project_defaults_agent_fk',
    columns: [table.orgId, table.agentId],
    foreignColumns: [agents.orgId, agents.id],
  }),
  foreignKey({
    name: 'agent_project_defaults_project_fk',
    columns: [table.orgId, table.projectId],
    foreignColumns: [projects.orgId, projects.id],
  }),
  tenantPolicy('agent_project_defaults_tenant'),
]).enableRLS();
