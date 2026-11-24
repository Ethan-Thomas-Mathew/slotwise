# 0015. Timeouts on queries, transactions, connections and requests

Status: accepted (November 2026, during the upgrade audit)

## Context

The API has 10 database connections. A stuck query, a transaction a bug forgets to
finish, or a client that sends its request very slowly each held a connection (and any
row locks) indefinitely. Ten of them would stop the API.

## Decision

The API and worker pools set, all as settings with defaults:

- `statement_timeout` 10 s: Postgres cancels any single statement that runs longer.
- `idle_in_transaction_session_timeout` 30 s: Postgres ends a transaction left open and
  idle, releasing its locks.
- Connect timeout 5 s.
- HTTP request timeout 30 s for a client to send its whole request (Node's default is
  5 minutes).

Migrations and scripts use no limits, since a long migration is legitimate.

## Consequences

- A waiting advisory lock counts towards the statement timeout; under extreme contention
  a hold fails with a server error after 10 seconds instead of waiting forever.

## Alternatives rejected

- **No timeouts:** one bug can take the whole service down.
- **Per-query timeouts in code:** easy to forget; the pool settings cover every query.
