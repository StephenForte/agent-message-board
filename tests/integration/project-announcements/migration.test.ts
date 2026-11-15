import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { expect, test } from 'vitest';
import { newId } from '../../../src/domain/kernel';

function statements(source: string) {
  return source.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean);
}

test('migration 0004 preserves populated orgs projects messages site and org announcements and revisions unchanged', async () => {
  const base = process.env.TEST_DATABASE_URL!;
  const name = `amb_t26_migration_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(base); url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  try {
    await client.connect();
    for (const file of readdirSync('drizzle').filter((file) => /^000[0-3]_.*\.sql$/.test(file)).sort()) {
      for (const statement of statements(readFileSync(`drizzle/${file}`, 'utf8'))) await client.query(statement);
    }
    const userId = newId(), orgId = newId(), projectId = newId(), messageId = newId();
    await client.query('insert into "user" (id,name,email,email_verified,created_at,updated_at) values ($1,\'Legacy\',$2,true,now(),now())', [userId, `${userId}@example.com`]);
    await client.query('insert into organizations (id,name,owner_user_id,status) values ($1,\'Legacy org\',$2,\'active\')', [orgId, userId]);
    await client.query(`insert into projects (id,org_id,slug,name,status,created_by_kind,created_by_user_id) values ($1,$2,'legacy','Legacy','active','human',$3)`, [projectId, orgId, userId]);
    await client.query(`insert into messages (id,org_id,project_id,title,body,category,status,urgent,pinned,version,last_activity_at,author_kind,author_user_id,author_display_name)
      values ($1,$2,$3,'Legacy message','Existing message body','note','active',false,false,1,now(),'human',$4,'Legacy')`, [messageId, orgId, projectId, userId]);
    for (const scope of ['site', 'org']) {
      const id = newId();
      await client.query(`insert into announcements (id,scope,org_id,title,body,version,author_user_id) values ($1,$2,$3,$4,$5,1,$6)`, [id, scope, scope === 'site' ? null : orgId, `${scope} title`, `${scope} body`, userId]);
      await client.query(`insert into announcement_revisions (id,announcement_id,scope,org_id,title,body,version,author_user_id) values ($1,$2,$3,$4,$5,$6,1,$7)`, [newId(), id, scope, scope === 'site' ? null : orgId, `${scope} title`, `${scope} body`, userId]);
    }
    const tables = ['organizations', 'projects', 'messages', 'announcements', 'announcement_revisions'];
    const snapshot = async () => Promise.all(tables.map(async (table) =>
      (await client.query(`select to_jsonb(t) - 'project_id' as row from ${table} t order by id`)).rows));
    // messages already has project_id; verify it separately, and compare every legacy announcement column.
    const before = await snapshot();
    expect(before.map((rows) => rows.length)).toEqual([1, 1, 1, 2, 2]);
    for (const statement of statements(readFileSync('drizzle/0004_project_announcements.sql', 'utf8'))) await client.query(statement);
    expect(await snapshot()).toEqual(before);
    expect((await client.query('select project_id from messages where id=$1', [messageId])).rows).toEqual([{ project_id: projectId }]);
    for (const table of ['announcements', 'announcement_revisions']) {
      expect((await client.query(`select project_id from ${table}`)).rows).toEqual([{ project_id: null }, { project_id: null }]);
    }
  } finally {
    await client.end();
    const deadline = Date.now() + 5000;
    while (Number((await admin.query('select count(*) as n from pg_stat_activity where datname=$1', [name])).rows[0].n)) {
      if (Date.now() > deadline) throw new Error('migration database backends did not drain');
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await admin.query(`DROP DATABASE "${name}"`);
    await admin.end();
  }
});
