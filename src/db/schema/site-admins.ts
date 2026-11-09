import { pgTable, text } from 'drizzle-orm/pg-core';
import { user } from './auth';

/** D-006 as a separate table, not a Better Auth user field. No RLS: it is a global role. */
export const siteAdmins = pgTable('site_admins', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
});
