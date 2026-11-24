# 0001. One repository; the API and web app share Zod schemas

Status: accepted (November 2026)

## Context

The API and the web app exchange about 50 request and response shapes. If each side
declares them separately, they drift: a field renamed on the server breaks the form
that sends it, and nothing notices until a user does.

## Decision

One pnpm workspace: `apps/api`, `apps/web`, `packages/shared`. The shared package holds
Zod schemas. The API validates input and its own output with them; the web app uses
the same schemas for form validation and the inferred TypeScript types for responses.
The shared package is consumed as TypeScript source, with no build step of its own.

## Consequences

- A schema change and every place that uses it change in one commit, and the type
  checker finds every place that must change.
- Product rules the customer sees, such as the hold length, live in one place
  (`HOLD_MINUTES` in the shared package).
- Both consumers must compile TypeScript (Vite and tsx/tsup both do).
- One CI pipeline builds everything; fine at three packages.

## Alternatives rejected

- **Separate repositories:** schema changes need coordinated releases.
- **Turborepo or Nx on top:** caching and task graphs pay off with many packages, not three.
- **Generating a client from OpenAPI:** adds a code-generation step to keep in sync; sharing
  the source schemas is simpler when both sides are TypeScript.
