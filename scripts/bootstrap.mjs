// One-command development setup: `pnpm bootstrap`.
// Plain Node with no dependencies, so it runs the same on Windows, macOS and Linux,
// before anything else is installed. Safe to run again: every step is idempotent.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const windows = process.platform === 'win32';

function run(title, command, args) {
  console.log(`\n> ${title}`);
  // shell is needed on Windows to find pnpm.cmd; the arguments are fixed strings.
  const { status, error } = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: windows,
  });
  if (error || status !== 0) {
    console.error(`\nStopped: "${title}" failed.${error ? ` ${error.message}` : ''}`);
    if (command === 'docker') console.error('Is Docker Desktop running?');
    process.exit(1);
  }
}

run('Install dependencies', 'pnpm', ['install', '--frozen-lockfile']);
run('Start Postgres, Redis and Mailpit (waits until healthy)', 'docker', [
  'compose',
  'up',
  '-d',
  '--wait',
]);

const envFile = `${root}apps/api/.env`;
if (existsSync(envFile)) {
  console.log('\n> apps/api/.env exists; leaving it as it is');
} else {
  copyFileSync(`${root}.env.example`, envFile);
  console.log('\n> Created apps/api/.env from .env.example');
}

run('Apply database migrations', 'pnpm', ['db:migrate']);
run('Add demo data (skipped if already there)', 'pnpm', ['db:seed']);

console.log('\nReady. Start everything with: pnpm dev');
console.log(
  'Then open http://localhost:5173/b/glow-salon (log in as owner@glow.demo / password123)',
);
