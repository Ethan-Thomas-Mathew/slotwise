# Architecture

## The pieces

```mermaid
flowchart LR
  subgraph Browser
    W[React app<br/>apps/web]
    RZ[Razorpay Checkout]
  end
  subgraph Server
    N[nginx<br/>static files + /api proxy]
    A[Fastify API<br/>apps/api]
    K[Worker<br/>BullMQ]
  end
  PG[(PostgreSQL 16<br/>RLS + exclusion constraint)]
  R[(Redis<br/>queues + rate limits)]
  RP[Razorpay]
  M[SMTP<br/>Mailpit / Resend]

  W -- "/api/* (cookie + CSRF)" --> N --> A
  W --> RZ --> RP
  RP -- "signed webhook" --> A
  A -- "app role, RLS applies" --> PG
  A -- "enqueue after commit" --> R
  K -- "jobs" --> R
  K --> PG
  K --> M
  K -- "refunds" --> RP
```

- **apps/web**: React + Vite. Talks only to `/api`, which nginx (production) or Vite (development) forwards to the API, so the browser sees a single origin.
- **apps/api**: Fastify. Validates input with the shared Zod schemas, runs every request in a tenant-scoped transaction, and queues background work after commit.
- **Worker**: the same codebase, a different entry point (`src/worker.ts`). Sends emails, expires holds, processes refunds, and runs the reconciler every minute.
- **packages/shared**: Zod schemas and types used by both the API and the frontend.

## A request, end to end

```mermaid
sequenceDiagram
  participant B as Browser
  participant API as Fastify
  participant DB as Postgres
  B->>API: POST /bookings/hold (cookie, x-csrf-token)
  API->>API: Origin check, session → req.auth, requireRole('CUSTOMER'), Zod parse
  API->>DB: BEGIN; set_config('app.tenant_id', …, true)
  API->>DB: is this a real slot? (slot generator)
  API->>DB: pg_advisory_xact_lock(staff); expire stale holds
  API->>DB: INSERT booking (HELD)
  alt exclusion constraint violated
    DB-->>API: 23P01
    API-->>B: 409 SLOT_TAKEN
  else inserted
    API->>DB: COMMIT
    API->>API: after commit: queue hold-expiry job
    API-->>B: 201 booking
  end
```

## Payment flow

```mermaid
sequenceDiagram
  participant B as Browser
  participant API
  participant RP as Razorpay
  participant DB as Postgres
  participant Q as Worker
  B->>API: POST /payments/order {bookingId}
  API->>RP: create order (amount from DB)
  API-->>B: orderId
  B->>RP: pay in Checkout
  B->>B: "Confirming…" (polls the booking)
  RP->>API: POST /webhooks/razorpay (HMAC signature)
  API->>API: verify signature on raw body
  API->>DB: one transaction: insert event_id (unique) → CAPTURED → CONFIRMED → notification rows
  API->>Q: (after commit) schedule confirmation + 24h reminder
  Q->>DB: lock notification row, still due?
  Q->>Q: send email
```

## Booking states

```mermaid
stateDiagram-v2
  [*] --> HELD: hold (10 min)
  HELD --> CONFIRMED: payment webhook
  HELD --> EXPIRED: hold timed out
  HELD --> CANCELLED: customer abandons
  EXPIRED --> CONFIRMED: late payment, slot still free
  CONFIRMED --> CANCELLED: cancel (refund per policy)
  CONFIRMED --> COMPLETED: staff, after start
  CONFIRMED --> NO_SHOW: staff, after start
```

## Code layout

```
apps/api/src/
  app.ts            builds the Fastify app (no listen) – used by tests
  index.ts          starts the API
  worker.ts         starts the background workers
  config.ts         environment variables, validated
  metrics.ts        Prometheus metrics and their internal server
  db/               connection, migrations, schema types, withTenant()
  http/             request authentication (sessions, CSRF, roles), error handler,
                    errors, input/output validation, path parameters
  modules/<area>/   repo.ts (data access) · service.ts (rules) · routes.ts (HTTP)
  jobs/             queues, BullMQ implementation, workers, post-commit effects
  credentials/      password hashing, random tokens
  mail/             SMTP mailer, HTML escaping for emails
  openapi/          the API description (OpenAPI 3.1) built from the route schemas
apps/api/scripts/ops/  backup and restore drill
apps/api/tests/
  unit/             pure logic: slot generator, state machine, cancellation policy
  integration/      HTTP + real Postgres + real Redis
  support/          test app, data factories, fakes for jobs and email
apps/web/src/
  api/              fetch client, query cache, session hooks (useMe, useLogin...)
  time/             formatting in the business's timezone, a ticking clock
  components/       UI kit, layouts
  features/         auth, booking, owner, staff, customer
e2e/                Playwright: critical paths + accessibility
ops/prometheus/     scrape config, alert rules and their unit tests
ops/grafana/        provisioned datasource and dashboard
docs/openapi.json   generated API description (kept in git so API changes show in review)
```

## Where each "hard problem" lives

| Problem           | Code                                                                                                                           | Tests                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Tenant isolation  | `db/tenant-tx.ts`, `migrations/0002_row_level_security.ts`, every `repo.ts`                                                    | `tenant-isolation.db.test.ts`, `catalog.test.ts`, `bookings.test.ts`, `roles.test.ts` |
| No double booking | `migrations/0001_init.ts` (exclusion constraint), `bookings/repo.ts` (`lockStaffCalendar`), `bookings/service.ts` (`holdSlot`) | `bookings.test.ts` (20 parallel holds × 10)                                           |
| Reliable payments | `payments/service.ts` (`handleWebhook`, `processRefund`), `payments/routes.ts` (raw body)                                      | `payments.test.ts`, `e2e/booking-flow.spec.ts`                                        |
