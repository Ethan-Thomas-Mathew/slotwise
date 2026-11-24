# 0011. Metrics on an internal port, alerts with tests, and a runbook

Status: accepted (November 2026)

## Context

Logs explain one request. Knowing whether the service as a whole is healthy (error rate,
latency, stuck jobs) needs numbers over time, and an alert is only useful if it says what
to do.

## Decision

- The API and worker expose Prometheus metrics (`prom-client`) on separate ports (9464,
  9465), bound to `127.0.0.1` by default. In Docker they listen only inside the private
  network; the ports aren't published and nginx doesn't proxy them.
- HTTP metrics are labelled by route template (`/bookings/:id`), never the raw URL.
  Unknown URLs share one `unmatched` label. Otherwise ids would leak into metrics and a
  scanner requesting random URLs could create unlimited time series.
- Business counters: holds, webhook outcomes (including `rejected`), refunds, error codes
  such as `SLOT_TAKEN` and `BAD_SIGNATURE`; queue depth read at scrape time.
- Prometheus and Grafana run in an opt-in compose profile. Grafana is read-only for
  anonymous viewers, with no login form and a random admin password.
- Eight alert rules, each linking to a section of `docs/RUNBOOK.md`, with unit tests
  (`promtool test rules`) so a typo can't produce an alert that never fires.

## Consequences

- Locally, alerts appear on Prometheus's alerts page; sending them anywhere would need
  Alertmanager.
- Two more containers when the profile is on.

## Alternatives rejected

- **Metrics on the public API port:** exposes internals.
- **Labelling by URL:** unbounded memory, and ids in metrics.
