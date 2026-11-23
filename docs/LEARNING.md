# Learning notes

Plain-language notes, one section per phase: what was built, why, and the concepts to understand.

---

## Phase 0: Foundation

**What was built:** the empty "skeleton" of the project. Nothing a user can see yet, but everything later phases rely on: the folder layout, TypeScript settings, linting, formatting, tests, local databases and CI.

**Why it matters:** Setting up tooling first means every line written later is type-checked, linted and tested automatically. In interviews, "a fresh clone runs with one command and CI is green" signals you work like a professional team.

**How the pieces fit:**

- `pnpm-workspace.yaml` tells pnpm that `apps/*` and `packages/*` are separate packages in one repo. `apps/api` can depend on `@slotwise/shared` with `"workspace:*"`.
- `tsconfig.base.json` holds TypeScript settings every package shares. `strict: true` turns on all the safety checks. `noUncheckedIndexedAccess` means `array[0]` has type `T | undefined`, which forces you to handle "it might not be there".
- `eslint.config.js` catches likely bugs (unused variables, `console.log` left in code). Prettier only formats.
- `docker-compose.yml` runs Postgres, Redis and Mailpit locally so nobody has to install them by hand.
- `apps/api/src/config.ts` reads environment variables **once**, validates them with Zod and crashes at startup if something is wrong.
- `apps/api/src/app.ts` builds the Fastify app **without** starting it. Tests use `app.inject()` to send fake requests straight into the app. That's fast and needs no open port.
- `.github/workflows/ci.yml` runs install → lint → format check → type-check → tests → build on every push.

**Concepts:**

- **Monorepo:** several related projects in one Git repository.
- **Strict TypeScript:** the compiler refuses code where a value could be `null`/`undefined` and you didn't handle it.
- **Linter vs formatter:** a linter finds suspicious code; a formatter only changes spacing and layout.
- **Environment variables:** settings that live outside the code (passwords, URLs) so the same code runs in dev, test and production.
- **CI (Continuous Integration):** a server that automatically checks every change.
- **Docker Compose:** a file describing several containers (database, cache…) that start together.
