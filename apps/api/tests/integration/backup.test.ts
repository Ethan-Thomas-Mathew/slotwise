import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { backup } from '../../scripts/ops/backup';
import { restoreDrill } from '../../scripts/ops/restore-drill';

/** The backup and restore-drill scripts, run for real against the test database. */
function pgDumpMajor(): number {
  try {
    return Number(/(\d+)/.exec(execFileSync('pg_dump', ['--version']).toString())![1]);
  } catch {
    return 0;
  }
}
const liveDb = new URL(process.env.MIGRATION_DATABASE_URL!).pathname.slice(1);
const dir = mkdtempSync(join(tmpdir(), 'slotwise-backup-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(pgDumpMajor() < 16)('backups', () => {
  let file: string;

  it('writes a backup and its checksum', async () => {
    const res = await backup({ mode: 'local', database: liveDb, dir });
    file = res.file;
    expect(res.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('restores into a scratch database with every table, migration and RLS policy', async () => {
    const r = await restoreDrill({ mode: 'local', file, liveDatabase: liveDb });
    expect(r.ok).toBe(true);
    expect(r.missingTables).toEqual([]);
    expect(r.sameMigrations).toBe(true);
    expect(r.policies).toBeGreaterThan(10);
    expect(r.restored).toHaveProperty('bookings');
  });

  it('detects a damaged backup before restoring it', async () => {
    appendFileSync(file, 'x');
    await expect(restoreDrill({ mode: 'local', file, liveDatabase: liveDb })).rejects.toThrow(
      /Checksum mismatch/,
    );
  });

  it('refuses to use the live database as the scratch database', async () => {
    await expect(
      restoreDrill({ mode: 'local', file, liveDatabase: 'slotwise_restore_drill' }),
    ).rejects.toThrow(/must not be the live one/);
  });
});
