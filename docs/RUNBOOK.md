# Runbook

What to do when something goes wrong, and how to do the routine jobs. Written for
the local Docker setup; the same steps apply to a real server with its own URLs.

Every command runs from the project folder.

## Quick reference

| What                  | Where                                                 |
| --------------------- | ----------------------------------------------------- |
| The app               | http://localhost:8080                                 |
| Emails it sent        | http://localhost:8025 (Mailpit)                       |
| API docs              | http://localhost:8080/api/docs                        |
| Is the API alive?     | http://localhost:8080/api/health                      |
| Can it serve traffic? | http://localhost:8080/api/ready (checks DB and Redis) |
| Metrics and alerts    | http://localhost:9090/alerts (Prometheus)             |
| Dashboard             | http://localhost:3001 (Grafana, "Slotwise overview")  |

```bash
docker compose --profile full up -d --build                          # the app
docker compose --profile full --profile observability up -d --build  # app + monitoring
docker compose ps                                                    # what's running, and healthy?
docker compose logs -f api worker                                    # follow the logs
docker compose --profile full --profile observability down           # stop (data is kept)
```

Every log line has a `reqId`. When a user reports an error, the response's
`x-request-id` header is that id: search the logs for it to see exactly what happened.

## Alerts

Each alert in `ops/prometheus/alerts.yml` links to one section below.

### API is down

`ApiDown`: Prometheus could not reach the API for a minute.

1. `docker compose ps api`: is it running? Is it `unhealthy`?
2. `docker compose logs --tail=100 api`: look for the error just before it stopped.
   - `Invalid environment configuration`: a setting is missing or wrong; the message names it.
   - `ECONNREFUSED ...5432`: Postgres is down. `docker compose up -d postgres`.
3. Restart it: `docker compose --profile full up -d api`.
4. Confirm: http://localhost:8080/api/ready shows `"status":"ok"`.

### Worker is down

`WorkerDown`: emails, hold expiry and refunds have stopped. Nothing is lost: the
work waits in Redis (and the database outbox) and runs when the worker is back.

1. `docker compose logs --tail=100 worker`.
2. `docker compose --profile full up -d worker`.
3. Within a minute the reconciler catches up on anything missed.

### High error rate

`HighErrorRate`: more than 5% of requests fail with a 5xx (a bug or an outage).

1. Grafana → "Responses by status" and "Requests by route": which route?
2. `docker compose logs api | grep '"level":50'`: the `Unhandled error` lines, with stack traces.
3. If Postgres or Redis is down, `/api/ready` says which. Restart it.
4. If it started after a change, roll back to the previous version and investigate.

### Slow requests

`SlowRequests`: the slowest 5% of requests take more than a second.

1. Grafana → "Latency" and "Requests by route": one route, or all of them?
2. All routes: check "Event loop lag" (CPU-heavy code) and the database
   (`docker stats` for CPU and memory).
3. One route: reproduce with `pnpm --filter @slotwise/api bench` and look at the query plan
   (`EXPLAIN ANALYZE`). See docs/PERFORMANCE.md.

### Jobs failing

`JobsFailing`: background jobs keep failing (each is retried 6 times with backoff).

1. `docker compose logs worker | grep 'Job failed'`: the queue and the error.
2. Emails: is Mailpit (or the real SMTP server) reachable?
3. Refunds: is the payment provider reachable? Refunds are safe to retry: the job
   first asks the provider whether the refund already happened.
4. Emails that failed every attempt appear on the owner's **Emails** page, with a Retry button.

### Queue backlog

`QueueBacklog`: over 100 jobs waiting for 10 minutes. The worker is down, stuck, or too slow.

1. Is the worker running? (See "Worker is down".)
2. Grafana → "Queue depth": which queue? Is "waiting" growing or shrinking?
3. If it's shrinking, it will catch up. If it's growing, start a second worker:
   `docker compose --profile full up -d --scale worker=2` (jobs are safe to run in parallel).

### Webhook signature failures

`WebhookSignatureFailures`: payment webhooks arrive with invalid signatures.

- Either someone is sending fake "payment succeeded" messages (they are rejected, so
  no booking is confirmed), or our `RAZORPAY_WEBHOOK_SECRET` doesn't match the one
  in the Razorpay dashboard.
- If it started right after a secret change, fix the secret. Otherwise, nothing to
  fix: the check is doing its job. Note the source IPs in the logs.

## Backups

```bash
pnpm db:backup          # writes backups/slotwise-<time>.dump and a .sha256 checksum
pnpm db:restore-drill   # proves the newest backup restores (into a scratch database)
```

- `backups/` is git-ignored and docker-ignored: backups contain names and emails.
- A backup you haven't restored is only a hope. The drill restores it into a separate
  database (`slotwise_restore_drill`), checks every table, the migrations and the
  row-level security policies are there, prints row counts, then removes it.
  It never touches the live database.
- On a real server: run the backup on a schedule (e.g. nightly), copy it off the
  machine, encrypt it, keep 30 days, and run the drill weekly.

### Restoring over the live database (deliberate, manual)

Only when the live data is lost or corrupted. This replaces everything.

```bash
docker compose --profile full stop api worker      # nobody can write while you restore
docker compose exec -T postgres psql -U postgres -c "DROP DATABASE slotwise WITH (FORCE)"
docker compose exec -T postgres psql -U postgres -c "CREATE DATABASE slotwise OWNER slotwise_owner"
docker compose exec -T postgres pg_restore -U postgres -d slotwise --exit-on-error < backups/<file>.dump
docker compose --profile full up -d api worker
```

Bookings made after the backup are gone; payments for them still exist at the
payment provider. Compare the provider's dashboard with the restored data.

## Privacy requests (India's DPDP Act)

- **"Give me my data"**: the person opens **Your account → Download my data**. It
  contains their profile, memberships, bookings and payments.
- **"Delete my account"**: **Your account → Delete account**. It asks for the password
  and the word DELETE. Refused, with a clear message, for owners, team members and
  anyone with upcoming bookings. Past bookings stay for the business's accounts but
  say "Deleted user"; the email is also removed from old audit entries.
- **A team member wants to leave**: the owner removes them on the Team page, then
  they can delete their account.
- **An owner wants to close their business**: not self-service. It needs a decision
  about refunds for upcoming bookings first.

## Common problems

| Symptom                               | Fix                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `Cannot connect to the Docker daemon` | Start Docker Desktop and wait until it says "running".                            |
| `port is already allocated`           | Something else uses that port. `docker compose ps -a`, or stop the other program. |
| Worker shows `unhealthy`              | Pull the latest `docker-compose.yml` (the worker has no HTTP health check).       |
| Changes to the code don't show up     | Rebuild: `docker compose --profile full up -d --build`.                           |
| Start again with fresh demo data      | `docker compose --profile full down -v` (deletes ALL data), then `up --build`.    |
