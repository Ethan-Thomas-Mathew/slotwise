import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { backup } from '../../scripts/ops/backup';
import type { Mode } from '../../scripts/ops/pg-tools';
import { restoreDrill } from '../../scripts/ops/restore-drill';

/**
 * The backup and restore-drill scripts, run for real against the test database.
 * CI sets PG_TOOLS_CONTAINER so the tools run inside its Postgres container; locally
 * they run from PATH, and only if their major version matches the server's (a newer
 * pg_restore emits settings an older server rejects).
 */
const mode: Mode = process.env.PG_TOOLS_CONTAINER ? 'docker' : 'local';

function majorVersion(output: string): number {
  return Number(/(\d+)/.exec(output)?.[1] ?? 0);
}
function localToolsMatchServer(): boolean {
  try {
    const client = majorVersion(execFileSync('pg_dump', ['--version']).toString());
    const server = majorVersion(
      execFileSync('psql', [
        process.env.MIGRATION_DATABASE_URL!,
        '-Atc',
        'SHOW server_version',
      ]).toString(),
    );
    return client > 0 && client === server;
  } catch {
    return false; // tools not installed
  }
}
const liveDb = new URL(process.env.MIGRATION_DATABASE_URL!).pathname.slice(1);
const dir = mkdtempSync(join(tmpdir(), 'slotwise-backup-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(mode === 'local' && !localToolsMatchServer())('backups', () => {
  let file: string;

  it('writes a backup and its checksum', async () => {
    const res = await backup({ mode, database: liveDb, dir });
    file = res.file;
    expect(res.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('restores into a scratch database with every table, migration and RLS policy', async () => {
    const r = await restoreDrill({ mode, file, liveDatabase: liveDb });
    expect(r.ok).toBe(true);
    expect(r.missingTables).toEqual([]);
    expect(r.sameMigrations).toBe(true);
    expect(r.policies).toBeGreaterThan(10);
    expect(r.restored).toHaveProperty('bookings');
  });

  it('detects a damaged backup before restoring it', async () => {
    appendFileSync(file, 'x');
    await expect(restoreDrill({ mode, file, liveDatabase: liveDb })).rejects.toThrow(
      /Checksum mismatch/,
    );
  });

  it('refuses to use the live database as the scratch database', async () => {
    await expect(
      restoreDrill({ mode, file, liveDatabase: 'slotwise_restore_drill' }),
    ).rejects.toThrow(/must not be the live one/);
  });
});
