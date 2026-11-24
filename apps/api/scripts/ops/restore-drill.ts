/**
 * A restore drill: proves a backup can actually be restored, WITHOUT touching
 * the live database. It restores into a separate scratch database, compares it
 * with the live one, then removes the scratch database.
 *   pnpm db:restore-drill                 (newest backup in backups/)
 *   pnpm db:restore-drill path/to.dump    (a specific one)
 *   add --local to use the tools on your PATH instead of Docker.
 *
 * Restoring over the LIVE database is a manual, deliberate step: see docs/RUNBOOK.md.
 */
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256File } from './backup';
import { modeFromArgs, pgTool, psql, REPO_ROOT, type Mode } from './pg-tools';

const DRILL_DB = 'slotwise_restore_drill';

const COUNT_SQL = `
  SELECT string_agg(c.relname || '=' || (xpath('/row/n/text()',
           query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]::text,
         ',' ORDER BY c.relname)
  FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'`;

function parseCounts(s: string): Record<string, number> {
  return Object.fromEntries(
    s
      .split(',')
      .filter(Boolean)
      .map((p) => {
        const [k, v] = p.split('=');
        return [k!, Number(v)];
      }),
  );
}

export function newestBackup(dir = join(REPO_ROOT, 'backups')): string {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.dump')) : [];
  if (!files.length) throw new Error(`No backups in ${dir}. Run: pnpm db:backup`);
  return join(dir, files.sort().at(-1)!);
}

export async function restoreDrill(opts: {
  mode: Mode;
  file: string;
  liveDatabase?: string;
  keep?: boolean;
}) {
  const live = opts.liveDatabase ?? 'slotwise';
  if (live === DRILL_DB) throw new Error('Refusing: the drill database must not be the live one');

  // 1. The file is exactly what was written (not truncated or corrupted).
  if (existsSync(`${opts.file}.sha256`)) {
    const expected = readFileSync(`${opts.file}.sha256`, 'utf8').split(/\s+/)[0];
    if ((await sha256File(opts.file)) !== expected) {
      throw new Error('Checksum mismatch: this backup file is damaged');
    }
  }

  // 2. Restore into a fresh scratch database.
  const admin = (q: string) => psql(opts.mode, 'postgres', q);
  await admin(`DROP DATABASE IF EXISTS ${DRILL_DB} WITH (FORCE)`);
  await admin(`CREATE DATABASE ${DRILL_DB}`);
  try {
    await pgTool('pg_restore', ['--exit-on-error', '--single-transaction'], {
      mode: opts.mode,
      database: DRILL_DB,
      stdin: createReadStream(opts.file),
    });

    // 3. Compare with the live database.
    const restored = parseCounts(await psql(opts.mode, DRILL_DB, COUNT_SQL));
    const current = parseCounts(await psql(opts.mode, live, COUNT_SQL));
    const migrations = (db: string) =>
      psql(opts.mode, db, "SELECT string_agg(name, ',' ORDER BY name) FROM kysely_migration");
    const sameMigrations = (await migrations(DRILL_DB)) === (await migrations(live));
    const missingTables = Object.keys(current).filter((t) => !(t in restored));
    const policies = Number(
      await psql(opts.mode, DRILL_DB, "SELECT count(*) FROM pg_policies WHERE schemaname='public'"),
    );
    const ok = sameMigrations && missingTables.length === 0 && policies > 0;
    return { ok, restored, current, sameMigrations, missingTables, policies };
  } finally {
    if (!opts.keep) await admin(`DROP DATABASE IF EXISTS ${DRILL_DB} WITH (FORCE)`);
  }
}

if (process.argv[1]?.endsWith('restore-drill.ts')) {
  const fileArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const file = fileArg ?? newestBackup();
  console.log(`Restore drill for ${file}`);
  restoreDrill({ mode: modeFromArgs(process.argv), file, keep: process.argv.includes('--keep') })
    .then((r) => {
      console.log('\nTable                  restored   live now');
      for (const t of Object.keys(r.current).sort()) {
        console.log(
          `${t.padEnd(22)} ${String(r.restored[t] ?? 'MISSING').padStart(8)} ${String(r.current[t]).padStart(10)}`,
        );
      }
      console.log('\n(Live counts can be higher if bookings were made after the backup.)');
      console.log(`Same migrations: ${r.sameMigrations ? 'yes' : 'NO'}`);
      console.log(`Row-level security policies restored: ${r.policies}`);
      if (!r.ok) {
        console.error('\nRESTORE DRILL FAILED');
        process.exit(1);
      }
      console.log('\nRestore drill passed: this backup can be restored.');
    })
    .catch((e: Error) => {
      console.error(`Restore drill failed: ${e.message}`);
      process.exit(1);
    });
}
