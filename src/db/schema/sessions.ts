import { sql } from 'drizzle-orm';
import {
  check, foreignKey, pgTable, primaryKey, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core';
import { agentTokens, agents } from './identity';
import { organizations } from './org';
import { tenantPolicy } from './policies';
import { projects } from './projects';

export const agentSessions = pgTable('agent_sessions', {
  id: uuid('id').notNull(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  agentId: uuid('agent_id').notNull(),
  tokenId: uuid('token_id').notNull(),
  clientLabel: text('client_label'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  /** Last time an `agent.session_seen` audit row was written for this session (D-033). Null until the first one. */
  lastSeenAuditedAt: timestamp('last_seen_audited_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  primaryKey({ columns: [table.id], name: 'agent_sessions_pkey' }),
  unique('agent_sessions_org_id_id').on(table.orgId, table.id),
  foreignKey({
    name: 'agent_sessions_agent_fk',
    columns: [table.orgId, table.agentId],
    foreignColumns: [agents.orgId, agents.id],
  }),
  foreignKey({
    name: 'agent_sessions_token_fk',
    columns: [table.orgId, table.tokenId],
    foreignColumns: [agentTokens.orgId, agentTokens.id],
  }),
  tenantPolicy('agent_sessions_tenant'),
  check('agent_sessions_client_label_len', sql`${table.clientLabel} is null or char_length(${table.clientLabel}) between 1 and 200`),
]).enableRLS();

/** The subset of permitted default projects selected for one session (PRD §6). */
export const agentSessionProjects = pgTable('agent_session_projects', {
  orgId: uuid('org_id').notNull(),
  sessionId: uuid('session_id').notNull(),
  projectId: uuid('project_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.orgId, table.sessionId, table.projectId], name: 'agent_session_projects_pkey' }),
  foreignKey({
    name: 'agent_session_projects_session_fk',
    columns: [table.orgId, table.sessionId],
    foreignColumns: [agentSessions.orgId, agentSessions.id],
  }),
  foreignKey({
    name: 'agent_session_projects_project_fk',
    columns: [table.orgId, table.projectId],
    foreignColumns: [projects.orgId, projects.id],
  }),
  tenantPolicy('agent_session_projects_tenant'),
]).enableRLS();
