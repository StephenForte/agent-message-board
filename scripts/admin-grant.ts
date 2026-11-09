import nextEnv from '@next/env';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, closeDb } from '../src/db/client';
import { user } from '../src/db/schema/auth';
import { siteAdmins } from '../src/db/schema/site-admins';

nextEnv.loadEnvConfig(process.cwd());
try {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email || process.argv.length !== 3) throw new Error('Usage: npm run admin:grant -- <email>');
  await getDb().transaction(async (tx) => {
    const [found] = await tx.select({ id: user.id }).from(user)
      .where(and(sql`lower(${user.email}) = ${email}`, eq(user.emailVerified, true))).for('share');
    if (!found) throw new Error('An existing verified user is required');
    await tx.insert(siteAdmins).values({ userId: found.id }).onConflictDoNothing();
  });
  console.info('Site admin granted (or already present).');
} catch (error) {
  console.error(error instanceof Error && /^(Usage:|An existing verified)/.test(error.message)
    ? error.message : 'Site admin grant failed');
  process.exitCode = 1;
} finally { await closeDb(); }
