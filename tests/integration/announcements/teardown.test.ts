import pg from 'pg';
import { expect, test } from 'vitest';
import { createAnnouncementDatabase } from './fixture';

/**
 * pg-pool resolves pool.end() as soon as it starts ending idle clients, before
 * those backends leave pg_stat_activity. CI then loses the race: DROP DATABASE
 * WITH (FORCE) terminates the still-open backends, and the pool emits 57P01
 * with nobody listening. Corking the sockets holds the Terminate message so
 * this process hits that ordering every time. The fixed teardown must wait
 * until the backends are gone and drop without FORCE.
 */
test('announcement teardown does not emit 57P01 while a backend is still connected', async () => {
  const fixture = await createAnnouncementDatabase();
  await fixture.admin.pool.query('select 1');
  await fixture.runtime.pool.query('select 1');
  const databaseName = databaseNameOf(fixture.admin.pool);
  const release = holdDisconnect([fixture.admin.pool, fixture.runtime.pool]);
  const unhandled: unknown[] = [];
  const onUncaught = (error: unknown) => { unhandled.push(error); };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
  try {
    await fixture.cleanup();
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    try {
      const left = await admin.query<{ n: number }>(
        'select count(*)::int as n from pg_database where datname = $1',
        [databaseName],
      );
      expect(left.rows[0]?.n).toBe(0);
    } finally {
      await admin.end();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unhandled.map(describeUnhandled)).toEqual([]);
  } finally {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUncaught);
    release();
  }
}, 30_000);

function databaseNameOf(pool: pg.Pool): string {
  const connectionString = pool.options.connectionString;
  if (!connectionString) throw new Error('announcement pool is missing a connection string');
  return decodeURIComponent(new URL(connectionString).pathname.slice(1));
}

function holdDisconnect(pools: pg.Pool[]): () => void {
  const sockets: Array<{ uncork: () => void }> = [];
  for (const pool of pools) {
    const clients = (pool as pg.Pool & { _clients?: pg.Client[] })._clients ?? [];
    expect(clients.length).toBeGreaterThan(0);
    for (const client of clients) {
      const socket = client.connection.stream;
      socket.cork();
      sockets.push(socket);
    }
  }
  const timer = setTimeout(() => {
    for (const socket of sockets) socket.uncork();
  }, 250);
  return () => {
    clearTimeout(timer);
    for (const socket of sockets) socket.uncork();
  };
}

function describeUnhandled(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const coded = error as { code?: unknown; message?: unknown; client?: { _ending?: boolean } };
    return `${String(coded.code)} ${String(coded.message)} ending=${coded.client?._ending}`;
  }
  return error instanceof Error ? error.message : String(error);
}
