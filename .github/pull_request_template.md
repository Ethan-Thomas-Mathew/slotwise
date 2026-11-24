## What and why

<!-- What does this change do, and what problem does it solve? Link the issue if there is one. -->

## How it was tested

<!-- New or changed tests, and anything you checked by hand (screenshots for UI changes). -->

## Checklist

- [ ] Tests added or updated, and `pnpm test` passes
- [ ] Any new tenant-owned table has `tenant_id`, a row-level security policy, and an isolation test
- [ ] New or changed routes: validated with a Zod schema, listed in `src/openapi/spec.ts`, and `pnpm --filter @slotwise/api openapi` re-run
- [ ] Database changes are a new migration with a working `down()` (never edit an old one)
- [ ] No secrets, personal data or backups in the diff
- [ ] Docs updated if behaviour changed (README, RUNBOOK, DECISIONS)
