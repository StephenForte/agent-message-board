import { sql, type SQL } from 'drizzle-orm';
import {
  boolean, check, customType, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { agentTokens, agents } from './identity';
import { tenantPolicy } from './policies';
import { projects } from './projects';
import { agentSessions } from './sessions';

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const messages = pgTable('messages', {
  id: uuid('id').notNull(),
  orgId: uuid('org_id').notNull(),
  projectId: uuid('project_id').notNull(),
  rootId: uuid('root_id'),
  title: text('title'),
  body: text('body').notNull(),
  category: text('category'),
  status: text('status'),
  urgent: boolean('urgent'),
  pinned: boolean('pinned'),
  version: integer('version'),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true, mode: 'date' }),
  authorKind: text('author_kind').notNull(),
  authorUserId: text('author_user_id').references(() => user.id),
  authorTokenId: uuid('author_token_id'),
  authorAgentId: uuid('author_agent_id'),
  authorSessionId: uuid('author_session_id'),
  authorDisplayName: text('author_display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  searchVector: tsvector('search_vector').generatedAlwaysAs(
    (): SQL => sql`to_tsvector('english', coalesce(title, '') || ' ' || body)`,
  ),
}, (table) => [
  primaryKey({ columns: [table.id], name: 'messages_pkey' }),
  unique('messages_org_id_id').on(table.orgId, table.id),
  unique('messages_org_project_id').on(table.orgId, table.projectId, table.id),
  foreignKey({
    name: 'messages_project_fk',
    columns: [table.orgId, table.projectId],
    foreignColumns: [projects.orgId, projects.id],
  }),
  foreignKey({
    name: 'messages_root_fk',
    columns: [table.orgId, table.projectId, table.rootId],
    foreignColumns: [table.orgId, table.projectId, table.id],
  }),
  foreignKey({
    name: 'messages_author_token_fk',
    columns: [table.orgId, table.authorTokenId],
    foreignColumns: [agentTokens.orgId, agentTokens.id],
  }),
  foreignKey({
    name: 'messages_author_agent_fk',
    columns: [table.orgId, table.authorAgentId],
    foreignColumns: [agents.orgId, agents.id],
  }),
  foreignKey({
    name: 'messages_author_session_fk',
    columns: [table.orgId, table.authorSessionId],
    foreignColumns: [agentSessions.orgId, agentSessions.id],
  }),
  tenantPolicy('messages_tenant'),
  index('messages_active_roots_activity').on(table.orgId, table.projectId, table.lastActivityAt.desc()).where(
    sql`${table.rootId} is null and ${table.status} = 'active'`,
  ),
  index('messages_replies_by_root').on(table.orgId, table.rootId, table.createdAt).where(
    sql`${table.rootId} is not null`,
  ),
  index('messages_search_idx').using('gin', table.searchVector),
  check('messages_body_len', sql`octet_length(${table.body}) <= 32768`),
  check('messages_title_len', sql`${table.title} is null or char_length(${table.title}) <= 200`),
  check('messages_display_name_len', sql`char_length(${table.authorDisplayName}) between 1 and 200`),
  check('messages_root_shape', sql`(
    (
      ${table.rootId} is null
      and ${table.title} is not null
      and char_length(${table.title}) between 1 and 200
      and ${table.category} in ('note', 'finding', 'decision', 'blocker', 'handoff')
      and ${table.status} in ('active', 'archived')
      and ${table.urgent} is not null
      and ${table.pinned} is not null
      and ${table.version} is not null
      and ${table.version} >= 1
      and ${table.lastActivityAt} is not null
    )
    or
    (
      ${table.rootId} is not null
      and ${table.rootId} <> ${table.id}
      and ${table.title} is null
      and ${table.category} is null
      and ${table.status} is null
      and ${table.urgent} is null
      and ${table.pinned} is null
      and ${table.version} is null
      and ${table.lastActivityAt} is null
    )
  )`),
  check('messages_author', sql`(
    (
      ${table.authorKind} = 'human'
      and ${table.authorUserId} is not null
      and ${table.authorTokenId} is null
      and ${table.authorAgentId} is null
      and ${table.authorSessionId} is null
    )
    or
    (
      ${table.authorKind} = 'agent'
      and ${table.authorUserId} is null
      and ${table.authorTokenId} is not null
      and ${table.authorAgentId} is not null
      and ${table.authorSessionId} is not null
    )
  )`),
]).enableRLS();

export const messageRecipients = pgTable('message_recipients', {
  orgId: uuid('org_id').notNull(),
  messageId: uuid('message_id').notNull(),
  agentId: uuid('agent_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.orgId, table.messageId, table.agentId], name: 'message_recipients_pkey' }),
  foreignKey({
    name: 'message_recipients_message_fk',
    columns: [table.orgId, table.messageId],
    foreignColumns: [messages.orgId, messages.id],
  }),
  foreignKey({
    name: 'message_recipients_agent_fk',
    columns: [table.orgId, table.agentId],
    foreignColumns: [agents.orgId, agents.id],
  }),
  tenantPolicy('message_recipients_tenant'),
  index('message_recipients_by_agent').on(table.orgId, table.agentId),
]).enableRLS();
