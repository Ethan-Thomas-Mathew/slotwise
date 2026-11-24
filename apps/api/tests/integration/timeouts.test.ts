import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { createDatabase } from '../../src/db/database';
import { createTestApp } from '../support/app';

describe('timeouts', () => {
  it('cancels a query that runs longer than the statement timeout', async () => {
    const db = createDatabase(process.env.DATABASE_URL!, { max: 1, statementTimeoutMs: 100 });
    try {
      await expect(sql`SELECT pg_sleep(2)`.execute(db)).rejects.toMatchObject({ code: '57014' });
      // The connection is still usable afterwards.
      const { rows } = await sql<{ ok: number }>`SELECT 1 AS ok`.execute(db);
      expect(rows[0]!.ok).toBe(1);
    } finally {
      await db.destroy();
    }
  });

  it('ends a transaction that sits idle too long, releasing its locks', async () => {
    const db = createDatabase(process.env.DATABASE_URL!, { max: 1, idleInTransactionMs: 100 });
    try {
      const stuck = db.transaction().execute(async (trx) => {
        await sql`SELECT 1`.execute(trx);
        await new Promise((r) => setTimeout(r, 400)); // a bug that forgets to finish
        await sql`SELECT 1`.execute(trx);
      });
      await expect(stuck).rejects.toThrow();
    } finally {
      await db.destroy();
    }
  });

  it('gives slow clients a bounded time to send their request', async () => {
    const t = await createTestApp({ config: { ...loadConfig(), HTTP_REQUEST_TIMEOUT_MS: 1234 } });
    try {
      expect(t.app.server.requestTimeout).toBe(1234);
    } finally {
      await t.close();
    }
  });
});
