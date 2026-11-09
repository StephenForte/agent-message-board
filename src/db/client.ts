import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index';

export type AppDatabase = NodePgDatabase<typeof schema>;
export type DbTx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

export function createDatabase(url: string): { pool: pg.Pool; db: AppDatabase } {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', () => undefined);
  return { pool, db: drizzle(pool, { schema }) };
}

let current: { url: string; pool: pg.Pool; db: AppDatabase } | undefined;

export function getDb(): AppDatabase {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  if (!current || current.url !== url) {
    const previous = current;
    current = { url, ...createDatabase(url) };
    if (previous) void previous.pool.end().catch(() => undefined);
  }
  return current.db;
}

export async function closeDb(): Promise<void> {
  if (!current) return;
  const pool = current.pool;
  current = undefined;
  await pool.end();
}
