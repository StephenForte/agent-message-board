import { sql } from 'drizzle-orm';
import {
  bigint, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { agentTokens, agents } from './identity';
import { organizations } from './org';
import { tenantPolicy } from './policies';
import { projects } from './projects';
import { agentSessions } from './sessions';
import { messages } from './messages';

export const events = pgTable('events', {
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  seq: bigint('seq', { mode: 'number' }).notNull(),
  kind: text('kind').notNull(),
  projectId: uuid('project_id'),
  messageId: uuid('message_id'),
  rootId: uuid('root_id'),
  agentId: uuid('agent_id'),
  tokenId: uuid('token_id'),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.orgId, table.seq], name: 'events_pkey' }),
  foreignKey({
    name: 'events_project_fk',
    columns: [table.orgId, table.projectId],
    foreignColumns: [projects.orgId, projects.id],
  }),
  foreignKey({
    name: 'events_message_fk',
    columns: [table.orgId, table.messageId],
    foreignColumns: [messages.orgId, messages.id],
  }),
  foreignKey({
    name: 'events_root_fk',
    columns: [table.orgId, table.rootId],
    foreignColumns: [messages.orgId, messages.id],
  }),
  foreignKey({
    name: 'events_agent_fk',
    columns: [table.orgId, table.agentId],
    foreignColumns: [agents.orgId, agents.id],
  }),
  foreignKey({
    name: 'events_token_fk',
    columns: [table.orgId, table.tokenId],
    foreignColumns: [agentTokens.orgId, agentTokens.id],
  }),
  tenantPolicy('events_tenant'),
  check('events_seq_positive', sql`${table.seq} > 0`),
  check('events_kind', sql`${table.kind} in ('message.created', 'message.replied', 'message.flag_changed', 'message.archived', 'message.restored', 'project.created', 'project.updated', 'project.archived', 'project.restored', 'access.changed')`),
  check('events_payload_size', sql`octet_length(${table.payload}::text) <= 4096`),
  check('events_entity_len', sql`${table.entityType} is null or char_length(${table.entityType}) <= 100`),
]).enableRLS();

export const auditRecords = pgTable('audit_records', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  actorKind: text('actor_kind').notNull(),
  userId: text('user_id').references(() => user.id),
  tokenId: uuid('token_id'),
  agentId: uuid('agent_id'),
  sessionId: uuid('session_id'),
  interfaceKind: text('interface').notNull(),
  requestId: text('request_id').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  before: jsonb('before').$type<Record<string, unknown> | null>(),
  after: jsonb('after').$type<Record<string, unknown> | null>(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
  foreignKey({
    name: 'audit_records_token_fk',
    columns: [table.orgId, table.tokenId],
    foreignColumns: [agentTokens.orgId, agentTokens.id],
  }),
  foreignKey({
    name: 'audit_records_agent_fk',
    columns: [table.orgId, table.agentId],
    foreignColumns: [agents.orgId, agents.id],
  }),
  foreignKey({
    name: 'audit_records_session_fk',
    columns: [table.orgId, table.sessionId],
    foreignColumns: [agentSessions.orgId, agentSessions.id],
  }),
  tenantPolicy('audit_records_tenant'),
  index('audit_records_org_created').on(table.orgId, table.createdAt),
  check('audit_records_actor_kind', sql`${table.actorKind} in ('human', 'agent', 'system')`),
  check('audit_records_interface', sql`${table.interfaceKind} in ('web', 'mcp', 'cli')`),
  check('audit_records_action_len', sql`char_length(${table.action}) between 1 and 200`),
  check('audit_records_entity_len', sql`char_length(${table.entityType}) between 1 and 100 and char_length(${table.entityId}) between 1 and 200`),
  check('audit_records_request_len', sql`char_length(${table.requestId}) between 1 and 200`),
  check('audit_records_before_size', sql`${table.before} is null or octet_length(${table.before}::text) <= 16384`),
  check('audit_records_after_size', sql`${table.after} is null or octet_length(${table.after}::text) <= 16384`),
  check('audit_records_actor', sql`(
    (${table.actorKind} = 'human' and ${table.userId} is not null and ${table.tokenId} is null)
    or (${table.actorKind} = 'agent' and ${table.tokenId} is not null and ${table.userId} is null)
    or (${table.actorKind} = 'system' and ${table.userId} is null and ${table.tokenId} is null and ${table.agentId} is null and ${table.sessionId} is null)
  )`),
]).enableRLS();

export const idempotencyRecords = pgTable('idempotency_records', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  actorKind: text('actor_kind').notNull(),
  actorId: text('actor_id').notNull(),
  operation: text('operation').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  response: jsonb('response').$type<unknown>(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table) => [
  unique('idempotency_records_actor_op_key').on(
    table.orgId, table.actorKind, table.actorId, table.operation, table.idempotencyKey,
  ),
  tenantPolicy('idempotency_records_tenant'),
  index('idempotency_records_expires_at').on(table.expiresAt),
  check('idempotency_records_actor_kind', sql`${table.actorKind} in ('human', 'agent', 'system')`),
  check('idempotency_records_hash', sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
  check('idempotency_records_key_len', sql`char_length(${table.idempotencyKey}) between 1 and 200 and char_length(${table.operation}) between 1 and 200`),
  check('idempotency_records_actor_len', sql`char_length(${table.actorId}) between 1 and 200`),
]).enableRLS();

export const rateLimitWindows = pgTable('rate_limit_windows', {
  orgId: uuid('org_id').notNull(),
  tokenId: uuid('token_id').notNull(),
  bucket: text('bucket').notNull(),
  windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' }).notNull(),
  count: integer('count').notNull(),
}, (table) => [
  primaryKey({
    columns: [table.orgId, table.tokenId, table.bucket, table.windowStart],
    name: 'rate_limit_windows_pkey',
  }),
  foreignKey({
    name: 'rate_limit_windows_token_fk',
    columns: [table.orgId, table.tokenId],
    foreignColumns: [agentTokens.orgId, agentTokens.id],
  }),
  tenantPolicy('rate_limit_windows_tenant'),
  check('rate_limit_windows_count', sql`${table.count} >= 0`),
  check('rate_limit_windows_bucket', sql`char_length(${table.bucket}) between 1 and 100`),
]).enableRLS();
