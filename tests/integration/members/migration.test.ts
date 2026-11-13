import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { expect, test } from 'vitest';
import { newId } from '../../../src/domain/kernel';

function sqlStatements(source: string): string[] {
  return source.split('--> statement-breakpoint').map((part) => part.trim()).filter((part) => part.length > 0);
}

test('migration 0003 on populated orgs projects tokens and messages adds member tables', async () => {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error('TEST_DATABASE_URL is required');
  const name = `amb_t23mig_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  try {
    await client.connect();
    const earlier = readdirSync('drizzle').filter((file) => /^\d{4}_.*\.sql$/.test(file) && Number(file.slice(0, 4)) < 3).sort();
    expect(earlier.map((file) => file.slice(0, 4))).toEqual(['0000', '0001', '0002']);
    for (const file of earlier) {
      for (const statement of sqlStatements(readFileSync(`drizzle/${file}`, 'utf8'))) await client.query(statement);
    }
    const userId = newId();
    const orgId = newId();
    const projectId = newId();
    const tokenId = newId();
    const messageId = newId();
    await client.query('insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, $2, $3, true, now(), now())', [userId, 'Legacy', `${userId}@example.com`]);
    await client.query('insert into organizations (id, name, owner_user_id, status) values ($1, $2, $3, $4)', [orgId, 'Legacy org', userId, 'active']);
    await client.query(`insert into projects (id, org_id, slug, name, status, created_by_kind, created_by_user_id, visibility)
      values ($1, $2, 'legacy', 'Legacy', 'active', 'human', $3, 'private')`, [projectId, orgId, userId]);
    await client.query(`insert into agent_tokens (id, org_id, label, prefix, token_hash, scope, can_create_projects, created_by_user_id)
      values ($1, $2, 'legacy', 'Ab12Cd34', $3, 'org', false, $4)`, [tokenId, orgId, 'a'.repeat(64), userId]);
    await client.query(`insert into messages (id, org_id, project_id, title, body, category, status, urgent, pinned, version, last_activity_at, author_kind, author_user_id, author_display_name)
      values ($1, $2, $3, 'Hello', 'Body', 'note', 'active', false, false, 1, now(), 'human', $4, 'Legacy')`, [messageId, orgId, projectId, userId]);
    const migration = readdirSync('drizzle').filter((file) => file.startsWith('0003_') && file.endsWith('.sql'));
    expect(migration).toHaveLength(1);
    for (const statement of sqlStatements(readFileSync(`drizzle/${migration[0]}`, 'utf8'))) await client.query(statement);
    const tables = await client.query<{ relname: string }>(`select relname from pg_class where relname in ('org_members','member_invitations') order by relname`);
    expect(tables.rows.map((row) => row.relname)).toEqual(['member_invitations', 'org_members']);
    const counts = await client.query<{ n: string }>('select count(*)::text as n from organizations union all select count(*)::text from projects union all select count(*)::text from agent_tokens union all select count(*)::text from messages');
    expect(counts.rows.map((row) => row.n)).toEqual(['1', '1', '1', '1']);
  } finally {
    await client.end();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const activity = await admin.query<{ n: number }>('select count(*)::int as n from pg_stat_activity where datname = $1', [name]);
      if (activity.rows[0]?.n === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  }
});
