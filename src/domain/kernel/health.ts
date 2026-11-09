import { sql } from 'drizzle-orm';
import type { AppDatabase } from '../../db/client';
import { getDb } from '../../db/client';

/** True when `select 1` succeeds. Driver errors are swallowed so URLs are not logged. */
export async function checkDatabase(database?: AppDatabase): Promise<boolean> {
  try {
    const db = database ?? getDb();
    await db.execute(sql`select 1 as ok`);
    return true;
  } catch {
    return false;
  }
}
