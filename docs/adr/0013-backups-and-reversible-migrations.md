# 0013. Backups proven by restoring; migrations tested in both directions

Status: accepted (November 2026)

## Context

A backup that has never been restored, and a migration `down()` that has never run, are
guesses. The moment you need them is during an incident.

## Decision

- `pnpm db:backup` writes a compressed `pg_dump` and a SHA-256 checksum into `backups/`,
  which is ignored by git and Docker (backups contain names and emails).
- `pnpm db:restore-drill` checks the checksum, restores into a separate scratch database,
  compares tables, migrations and RLS policies with the live database, and drops the copy.
  It cannot touch the live database; restoring over live data is a manual, documented step.
- The tools run inside the Postgres container by default, so nothing is installed on the
  host. Arguments are passed as a list (no shell) and passwords through environment
  variables.
- A test applies every migration to an empty database, fingerprints the schema, rolls the
  migrations back one by one, re-applies them, and requires the identical fingerprint.

## Consequences

- A corrupted backup file is caught before restoring (tested).
- The drill needs disk space for a second copy of the database.

## Alternatives rejected

- **A restore command that overwrites live data:** one wrong argument destroys data.
- **Untested `down()` functions:** they rot.
