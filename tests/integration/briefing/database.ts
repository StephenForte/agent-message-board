import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { adminUrl, openDatabase, runtimeUrl } from '../helpers';

/** Own database: the site announcement is global, so parallel suites must not share it. */
export async function briefingDatabase() {
  const name = `amb_briefing_${randomUUID().replaceAll('-', '')}`;
  const control = new pg.Client({ connectionString: adminUrl() });
  await control.connect();
  await control.query(`CREATE DATABASE "${name}"`);
  const adminAddress = new URL(adminUrl()); adminAddress.pathname = `/${name}`;
  const runtimeAddress = new URL(runtimeUrl()); runtimeAddress.pathname = `/${name}`;
  const admin = openDatabase(adminAddress.toString());
  const runtime = openDatabase(runtimeAddress.toString(), 8);
  async function close() {
    await runtime.pool.end();
    await admin.pool.end();
    // pool.end() can finish before the server has processed every termination packet.
    const deadline = Date.now() + 10000;
    for (;;) {
      const rows = await control.query('select count(*)::int as count from pg_stat_activity where datname=$1', [name]);
      if (rows.rows[0].count === 0) break;
      if (Date.now() > deadline) throw new Error('Briefing fixture backends did not drain before database teardown');
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    try { await control.query(`DROP DATABASE "${name}"`); }
    finally { await control.end(); }
  }
  try {
    await migrate(drizzle(admin.pool), { migrationsFolder: 'drizzle' });
    // Reuse the global setup's non-superuser role, granting access only to this database.
    const role = runtimeAddress.username;
    if (!/^amb_rt_[a-f0-9]+$/.test(role)) throw new Error('Unexpected integration runtime role');
    await admin.pool.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
    await admin.pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`);
    await admin.pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
    return { admin, runtime, url: runtimeAddress.toString(), close };
  } catch (error) { await close(); throw error; }
}
