import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { expect, test } from 'vitest';
import { newId } from '../../../src/domain/kernel';

test('0006 preserves seeded 0005 site/org/project rows and revisions and changes only body constraints', async () => {
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL! });
  await admin.connect();
  const name = `amb_t28_migration_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  try {
    await client.connect();
    const apply = async (file: string) => {
      for (const statement of readFileSync(`drizzle/${file}`, 'utf8').split('--> statement-breakpoint').filter(s => s.trim())) await client.query(statement);
    };
    for (const file of readdirSync('drizzle').filter(f => /^000[0-5]_.*\.sql$/.test(f)).sort()) await apply(file);
    const userId = newId(), orgId = newId(), projectId = newId();
    await client.query(`insert into "user" (id,name,email,email_verified) values ($1,'Legacy owner',$2,true)`, [userId, `${userId}@example.test`]);
    await client.query(`insert into organizations (id,name,owner_user_id,status) values ($1,'Legacy',$2,'active')`, [orgId, userId]);
    await client.query(`insert into projects (id,org_id,slug,name,status,created_by_kind,created_by_user_id) values ($1,$2,'legacy','Legacy','active','human',$3)`, [projectId, orgId, userId]);
    for (const scope of ['site', 'org', 'project']) {
      const id = newId();
      const fields = [id, scope, scope === 'site' ? null : orgId, scope === 'project' ? projectId : null, userId];
      await client.query(`insert into announcements (id,scope,org_id,project_id,title,body,version,author_user_id)
        values ($1,$2,$3,$4,'Legacy title','Legacy body',2,$5)`, fields);
      for (const version of [1, 2]) {
        await client.query(`insert into announcement_revisions (id,announcement_id,scope,org_id,project_id,title,body,version,author_user_id)
          values ($6,$1,$2,$3,$4,'Legacy title',$7,$8,$5)`, [...fields, newId(), `Legacy body v${version}`, version]);
      }
    }
    const snapshot = async () => ({
      current: (await client.query('select * from announcements order by id')).rows,
      revisions: (await client.query('select * from announcement_revisions order by id')).rows,
    });
    const constraints = async () => (await client.query(`select conname,pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid in ('announcements'::regclass,'announcement_revisions'::regclass) order by conname`)).rows;
    const before = await snapshot(), beforeConstraints = await constraints();
    expect(before.current).toHaveLength(3);
    expect(before.revisions).toHaveLength(6);
    await client.query('BEGIN');
    await apply('0006_announcement_body_cap.sql');
    await client.query('COMMIT');
    expect(await snapshot()).toEqual(before);
    const unchanged = (rows: { conname: string; definition: string }[]) => rows.filter(row => !row.conname.endsWith('_body_len'));
    expect(unchanged(await constraints())).toEqual(unchanged(beforeConstraints));
    for (const table of ['announcements', 'announcement_revisions']) {
      await client.query(`update ${table} set body=$1`, ['x'.repeat(200000)]);
      expect((await client.query(`select distinct octet_length(body) as n from ${table}`)).rows).toEqual([{ n: 200000 }]);
      await client.query(`update ${table} set body=$1`, ['é'.repeat(131072)]);
      expect((await client.query(`select distinct octet_length(body) as n from ${table}`)).rows).toEqual([{ n: 262144 }]);
      await expect(client.query(`update ${table} set body=$1`, ['x'.repeat(262145)])).rejects.toMatchObject({ code: '23514', constraint: `${table}_body_len` });
      await expect(client.query(`update ${table} set title=$1`, ['x'.repeat(16385)])).rejects.toMatchObject({ code: '23514', constraint: `${table}_title_len` });
    }
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
