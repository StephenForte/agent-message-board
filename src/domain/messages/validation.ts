import { z } from 'zod';
import { DomainError } from '../kernel';

export const categories = ['note', 'finding', 'decision', 'blocker', 'handoff'] as const;
const id = z.uuid().transform((value) => value.toLowerCase());
const recipients = z.array(id).max(20).transform((ids) => [...new Set(ids)].sort()).default([]);
const body = z.string().refine((value) => !value.includes('\0'), 'NUL is not supported');
const key = z.string().min(1).max(200);
export const rootInput = z.object({
  projectId: id, title: z.string().refine((s) => Array.from(s).length >= 1 && Array.from(s).length <= 200 && !s.includes('\0')),
  body, category: z.enum(categories).default('note'), recipients,
  urgent: z.boolean().default(false), pinned: z.boolean().default(false), idempotencyKey: key,
}).strict();
export const replyInput = z.object({ rootId: id, body, recipients, idempotencyKey: key }).strict();
export const flagsInput = z.object({
  rootId: id, expectedVersion: z.number().int().min(1), status: z.enum(['active', 'archived']).optional(),
  urgent: z.boolean().optional(), pinned: z.boolean().optional(), idempotencyKey: key,
}).strict();
export const listInput = z.object({
  projectIds: z.array(id).min(1).transform((ids) => [...new Set(ids)].sort()),
  status: z.enum(['active', 'archived', 'all']).default('active'), category: z.enum(categories).optional(),
  urgent: z.boolean().optional(), pinned: z.boolean().optional(), authorAgentId: id.optional(),
  authorUserId: z.string().min(1).max(200).optional(), recipientAgentId: id.optional(),
  query: z.string().max(1000).refine((s) => !s.includes('\0')).optional(),
  sort: z.enum(['activity', 'newest', 'oldest']).default('activity'),
  limit: z.number().int().min(1).max(100).default(20), cursor: z.string().max(8192).optional(),
}).strict();
export const threadInput = z.object({
  rootId: id, replyLimit: z.number().int().min(1).max(100).default(20), replyCursor: z.string().max(8192).optional(),
}).strict();
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new DomainError('validation_failed');
  const value = result.data;
  if (value && typeof value === 'object' && 'body' in value && typeof value.body === 'string'
    && Buffer.byteLength(value.body, 'utf8') > 32768) throw new DomainError('content_too_large');
  return value;
}
export type PostRootInput = z.input<typeof rootInput>;
export type PostReplyInput = z.input<typeof replyInput>;
export type UpdateRootFlagsInput = z.input<typeof flagsInput>;
export type ListThreadsInput = z.input<typeof listInput>;
export type GetThreadInput = z.input<typeof threadInput>;
