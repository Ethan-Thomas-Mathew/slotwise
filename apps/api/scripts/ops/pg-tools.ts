import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { resolve } from 'node:path';

/**
 * Runs the Postgres command-line tools (pg_dump, pg_restore, psql) in one of two ways:
 *  - "docker" (default): inside the postgres container from docker-compose.yml, as the
 *    postgres superuser. Nothing to install on your computer. PG_TOOLS_CONTAINER names
 *    another container instead (CI uses its Postgres service container).
 *  - "local": the tools on your PATH, connecting as the table owner from
 *    MIGRATION_DATABASE_URL (used by the automated test).
 * Arguments are passed as a list (never through a shell), and passwords via
 * environment variables (never on the command line, where other programs could see them).
 */
export type Mode = 'docker' | 'local';
export const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

interface RunOpts {
  mode: Mode;
  database: string;
  stdin?: Readable;
  stdout?: Writable;
}

export function pgTool(tool: 'pg_dump' | 'pg_restore' | 'psql', args: string[], o: RunOpts) {
  let cmd: string;
  let argv: string[];
  const env = { ...process.env };
  if (o.mode === 'docker') {
    // The tools must match the server's version: a newer pg_restore emits settings an
    // older server rejects. Running them inside the server's own container guarantees it.
    cmd = 'docker';
    const container = process.env.PG_TOOLS_CONTAINER;
    const target = container ? ['exec', '-i', container] : ['compose', 'exec', '-T', 'postgres'];
    argv = [...target, tool, '-U', 'postgres', '-d', o.database, ...args];
  } else {
    const url = new URL(process.env.MIGRATION_DATABASE_URL ?? '');
    if (!url.hostname) throw new Error('MIGRATION_DATABASE_URL is not set');
    Object.assign(env, {
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
    });
    cmd = tool;
    argv = ['-d', o.database, ...args];
  }

  return new Promise<string>((done, fail) => {
    const child = spawn(cmd, argv, {
      cwd: REPO_ROOT,
      env,
      stdio: [o.stdin ? 'pipe' : 'ignore', o.stdout ? 'pipe' : 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    if (o.stdout) child.stdout!.pipe(o.stdout);
    else child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    if (o.stdin) {
      // If the tool exits early, writing more input fails with EPIPE; its exit code
      // and stderr (reported below) are the real error, so this one adds nothing.
      child.stdin!.on('error', () => undefined);
      o.stdin.pipe(child.stdin!);
    }
    child.on('error', (e) =>
      fail(
        new Error(
          o.mode === 'docker'
            ? `Could not run docker (${e.message}). Is Docker Desktop running?`
            : `Could not run ${tool} (${e.message}). Is the PostgreSQL client installed?`,
        ),
      ),
    );
    child.on('close', (code) =>
      code === 0 ? done(out) : fail(new Error(`${tool} failed (exit ${code}): ${err.trim()}`)),
    );
  });
}

/** Runs one SQL statement with psql and returns the plain-text result. */
export const psql = (mode: Mode, database: string, sqlText: string) =>
  pgTool('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sqlText], { mode, database }).then(
    (s) => s.trim(),
  );

export const modeFromArgs = (argv: string[]): Mode =>
  argv.includes('--local') ? 'local' : 'docker';
