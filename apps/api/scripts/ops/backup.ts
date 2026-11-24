/**
 * Backs up the database to backups/slotwise-<time>.dump (+ a .sha256 checksum).
 *   pnpm db:backup            (uses the Docker postgres container)
 *   pnpm db:backup --local    (uses pg_dump on your PATH)
 *
 * The backups/ folder is in .gitignore and .dockerignore: a backup contains
 * people's names and emails, so it must never be committed or shipped in an image.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { modeFromArgs, pgTool, REPO_ROOT, type Mode } from './pg-tools';

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

export async function backup(opts: { mode: Mode; database?: string; dir?: string }) {
  const dir = opts.dir ?? join(REPO_ROOT, 'backups');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `slotwise-${stamp}.dump`);
  const out = createWriteStream(file, { mode: 0o600 }); // readable by you only
  try {
    // --format=custom: compressed, and pg_restore can restore it selectively.
    await pgTool('pg_dump', ['--format=custom'], {
      mode: opts.mode,
      database: opts.database ?? 'slotwise',
      stdout: out,
    });
    await new Promise((r) => out.end(r));
  } catch (e) {
    out.destroy();
    rmSync(file, { force: true }); // never leave a half-written backup behind
    throw e;
  }
  const hash = await sha256File(file);
  writeFileSync(`${file}.sha256`, `${hash}  ${basename(file)}\n`, { mode: 0o600 });
  return { file, hash };
}

if (process.argv[1]?.endsWith('backup.ts')) {
  backup({ mode: modeFromArgs(process.argv) })
    .then(({ file }) => {
      console.log(`Backup written: ${file}`);
      console.log('Check it restores with: pnpm db:restore-drill');
    })
    .catch((e: Error) => {
      console.error(`Backup failed: ${e.message}`);
      process.exit(1);
    });
}
