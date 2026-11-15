import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { expect, test } from 'vitest';
import { newId } from '../../../src/domain/kernel';

test('migration 0005 preserves seeded 0004 tokens including creation grants and defaults the new flag false', async () => {
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL! });
  await admin.connect();
  const name = `amb_t27_migration_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  try {
    await client.connect();
    for (const file of readdirSync('drizzle').filter(f => /^000[0-4]_.*\.sql$/.test(f)).sort()) {
      for (const statement of readFileSync(`drizzle/${file}`, 'utf8').split('--> statement-breakpoint').filter(s => s.trim())) await client.query(statement);
    }
    const userId = newId(), orgId = newId();
    await client.query(`insert into "user" (id,name,email,email_verified) values ($1,'Legacy owner',$2,true)`, [userId, `${userId}@example.test`]);
    await client.query(`insert into organizations (id,name,owner_user_id,status) values ($1,'Legacy',$2,'active')`, [orgId, userId]);
    for (let i = 0; i < 3; i++) {
      await client.query(`insert into agent_tokens (id,org_id,label,prefix,token_hash,scope,can_create_projects,created_by_user_id,revoked_at,expires_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [newId(), orgId, `Legacy ${i}`, `LEGACY0${i}`, 'a'.repeat(64), i === 0 ? 'org' : 'projects', i === 0, userId, i === 1 ? new Date(0) : null, i === 2 ? new Date(0) : null]);
    }
    const snapshot = async () => (await client.query(`select to_jsonb(t) - 'can_set_project_announcements' as row from agent_tokens t order by id`)).rows;
    const before = await snapshot();
    expect(before).toHaveLength(3);
    for (const statement of readFileSync('drizzle/0005_announcement_token_api.sql', 'utf8').split('--> statement-breakpoint').filter(s => s.trim())) await client.query(statement);
    expect(await snapshot()).toEqual(before);
    expect((await client.query('select can_set_project_announcements from agent_tokens')).rows).toEqual(Array(3).fill({ can_set_project_announcements: false }));
  } finally {
    await client.end();
    const deadline = Date.now() + 5000;
    while (Number((await admin.query('select count(*) as n from pg_stat_activity where datname=$1', [name])).rows[0].n)) {
      if (Date.now() > deadline) throw new Error('migration backends did not drain');
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
});
