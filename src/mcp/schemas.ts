import { z } from 'zod';
const id = z.uuid();
const session = { session_id: z.string() };
const format = z.enum(['json', 'markdown']).optional();
const page = z.number().int().min(1).max(100).optional();
const cursor = z.string().max(65536).optional();
const recipients = z.array(id).max(20).optional();
const key = z.string().min(1).max(200);
const category = z.enum(['note', 'finding', 'decision', 'blocker', 'handoff']);
export const schemas = {
  connect_agent: z.strictObject({ name: z.string(), client_label: z.string().optional() }),
  list_projects: z.strictObject({ ...session, include_archived: z.boolean().optional() }),
  create_project: z.strictObject({ ...session, name: z.string(), slug: z.string(), description: z.string().optional(), idempotency_key: key }),
  check_board: z.strictObject({ ...session, project_id: id.optional(), cursor, continuation: cursor,
    view: z.enum(['all', 'urgent', 'addressed']).optional(), limit: page,
    budget_bytes: z.number().int().min(1).max(65536).optional(), format }),
  list_messages: z.strictObject({ ...session, project_id: id.optional(), filters: z.strictObject({
    status: z.enum(['active', 'archived', 'all']).optional(), category: category.optional(),
    urgent: z.boolean().optional(), pinned: z.boolean().optional(), author_agent_id: id.optional(),
    author_user_id: z.string().optional(), recipient_agent_id: id.optional(),
  }), query: z.string().optional(), sort: z.enum(['activity', 'newest', 'oldest']).optional(), limit: page, cursor, format }),
  get_thread: z.strictObject({ ...session, root_id: id, reply_limit: page, reply_cursor: cursor, format }),
  post_message: z.strictObject({ ...session, project_id: id.optional(), title: z.string(), body: z.string(),
    category: category.optional(), recipients, urgent: z.boolean().optional(), pinned: z.boolean().optional(), idempotency_key: key }),
  reply_message: z.strictObject({ ...session, root_id: id, body: z.string(), recipients, idempotency_key: key }),
  update_message: z.strictObject({ ...session, root_id: id, expected_version: z.number().int().min(1),
    status: z.enum(['active', 'archived']).optional(), urgent: z.boolean().optional(), pinned: z.boolean().optional(), idempotency_key: key }),
};
export type ToolName = keyof typeof schemas;
export const toolNames = Object.keys(schemas) as ToolName[];
