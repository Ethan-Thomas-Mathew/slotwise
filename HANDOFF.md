# Handoff: finishing the upgrade

For whoever continues this work (a person or Claude Code). Read this file, then
`docs/AUDIT.md` (the findings and the plan). Delete this file in the last commit.

## Where things stand (24 November 2026)

The upgrade follows the plan at the end of `docs/AUDIT.md`. Phases 0 and 2 to 7 are
done, and Phase 8 (documentation) is about half done. `git log v1.0.0..HEAD` lists
every commit with its reason.

Done:

- All correctness and security findings (C1-C8, S1, S3, S4) and design findings
  (D1, D3-D7, D2 option B), each fix with a test.
- Sentry and `docs/DEPLOY.md` removed; `lib/` folders replaced by named modules.
- `pnpm bootstrap` and `pnpm dev` (which now starts the worker); one typeface; lint clean.
- The benchmark prints the hardware, versions and peak memory (`pnpm bench`).
- `docs/adr/` (15 ADRs) and `docs/WALKTHROUGH.md` (restructured: build, upgrade, five
  interview questions, practice exercises).
- `docs/screenshots/booking-page.png` and `owner-overview.png`.

## What's left

1. **Upgrade phase 1, on the Windows laptop:**
   `docker compose --profile full --profile observability up -d --build`, then
   `docker compose ps` (all healthy), http://localhost:8080/api/docs and
   http://localhost:3001 (Grafana) load. Grafana and the new Docker settings have never
   run on this machine. Fix anything that fails, one commit per fix.
2. **Benchmark on the laptop:** `pnpm bootstrap`, then `pnpm bench` twice. Copy the
   printed block (it includes the hardware) into the README.
3. **Rewrite `README.md`** in this order, plainly and concisely:
   1. what it is and the problem it solves (2-3 sentences)
   2. screenshot (`docs/screenshots/booking-page.png`)
   3. architecture: the Mermaid diagram from `docs/ARCHITECTURE.md` and a short data-flow
      explanation (request → tenant transaction → constraint → after-commit job → worker)
   4. quick start, copied from the commands below, tested on a clean clone
   5. design decisions and trade-offs: a short table (chosen / rejected / why) linking to
      the ADRs
   6. benchmarks: the measured block from step 2, with hardware
   7. known limitations and what's next (see WALKTHROUGH Part 3, question 5)

   Keep the demo logins table and a short tests table (counts from a real run).
   Remove the "built to industry standards" line and the "video to be recorded" line.

4. **Delete the docs the ADRs and walkthrough replace:** `docs/DECISIONS.md`,
   `docs/LEARNING.md`, `docs/INTERVIEW.md`, `docs/EXERCISES.md`, `docs/PERFORMANCE.md`,
   `docs/ARCHITECTURE.md`. First search for links to them
   (`grep -rn "DECISIONS\|LEARNING\|INTERVIEW\|EXERCISES\|PERFORMANCE\|ARCHITECTURE"`)
   and repoint them: CONTRIBUTING, SECURITY, CHANGELOG, RUNBOOK, ADRs, code comments.
5. **`docs/WALKTHROUGH.md`:** add "Upgrade phase 7: Benchmarks" (what the script records
   and why; numbers only from a real run) and "Upgrade phase 8: Documentation"
   (why ADRs replaced one long decisions file; why fewer documents). Update the phase 1
   text once the laptop run is done.
6. **`docs/AUDIT.md`:** add a "Status" section listing every finding as fixed (with the
   commit) or deferred (with the reason). Deferred so far: D2 option A (route table).
7. **`CHANGELOG.md`:** add an "Unreleased" entry summarising the upgrade.
8. **Final checks** (all must pass), then delete this file:

   ```bash
   git clone <repo> /tmp/fresh && cd /tmp/fresh
   pnpm bootstrap
   pnpm lint && pnpm format:check && pnpm typecheck
   pnpm test:coverage
   pnpm exec playwright install chromium && pnpm test:e2e
   pnpm audit --prod --audit-level high
   ```

   Anti-slop search (must find nothing outside `docs/AUDIT.md`):

   ```bash
   grep -rniwE "robust|seamless|powerful|leverage|blazing|enterprise-grade|cutting-edge|TODO|FIXME" \
     --include=*.ts --include=*.tsx --include=*.md . | grep -v node_modules
   ```

## Rules from the brief (non-negotiable)

- Small commits, one logical change each, imperative messages; never mix a refactor and a
  behaviour change; the app runs after every commit.
- No emojis, marketing words, placeholders, commented-out code or dead code.
- Comments explain why, not what.
- Every number in the docs was measured, with the hardware stated.
- Everything stays local: ports on 127.0.0.1, no cloud services, no API keys required.
- Explain every change in plain language in `docs/WALKTHROUGH.md`.

## Commands

```bash
pnpm bootstrap        # install, start Postgres/Redis/Mailpit, create apps/api/.env, migrate, seed
pnpm dev              # API :3000, worker, web :5173
pnpm test             # unit + integration (needs the containers from bootstrap)
pnpm test:e2e         # browser tests; starts its own servers
pnpm bench            # load test; prints hardware and a Markdown table
pnpm --filter @slotwise/api openapi   # regenerate docs/openapi.json after changing a route
docker compose --profile full up --build   # whole app in Docker at http://localhost:8080
```

## Things that will trip you up

- After changing any route or its schemas, run the `openapi` command above; a test fails
  if `docs/openapi.json` is stale or a route's documented access rule is wrong.
- The pre-commit hook runs ESLint and Prettier on staged files; if it changes a file,
  stage it again.
- Integration tests recreate a `slotwise_test` database each run; Postgres must be up.
- On Windows, run commands in PowerShell from the repository root.
