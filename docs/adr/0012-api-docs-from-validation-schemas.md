# 0012. API docs generated from the validation schemas

Status: accepted (November 2026); option B chosen during the upgrade audit

## Context

Hand-written API docs drift from the code within weeks. The routes already validate
input and output with Zod schemas.

## Decision

- `src/openapi/spec.ts` lists every route with the same Zod schemas the route uses, and
  converts them to an OpenAPI 3.1 document with `z.toJSONSchema`. The generated
  `docs/openapi.json` is committed, so API changes show in review.
- Swagger UI serves it at `/api/docs` locally; it is off by default when
  `NODE_ENV=production`, uses its own strict CSP and calls no outside validator.
- Tests check that every registered route is documented and every documented route
  exists, that the document is valid OpenAPI, that the committed file is current, and that
  each route's documented access rule (public, signed in, or roles) matches what the
  route enforces. The role guards carry their roles so the routes can report them.

## Consequences

- The route list exists in two places; tests catch a missing route, an extra one, or a
  wrong access rule, but a wrong body schema in the docs would only be caught in review.

## Alternatives rejected

- **One route table per module that both registers routes and builds the docs (option A):**
  removes the duplication, but means rewriting all eleven route modules. Deferred; the
  tests cover the likely mistakes.
- **Hand-written YAML:** drifts.
