# 0010. Runs locally and offline; no cloud services

Status: accepted (November 2026, during the upgrade audit)

## Context

The project is shown running on a laptop. It must work without accounts, API keys,
paid services or an internet connection once dependencies and images are installed, and
nothing it starts should be reachable from other devices.

## Decision

- Every port in `docker-compose.yml` is bound to `127.0.0.1`. A test fails if one isn't,
  if an internal metrics port is published, or if an image isn't pinned to a version.
- Payments default to the mock provider (ADR 0007). The Razorpay adapter remains, off by
  default, to show the integration is real.
- Email goes to Mailpit, which keeps every message locally.
- Fonts are bundled with the app, not loaded from a CDN.
- Sentry and the cloud deployment guide were removed: a cloud service, even switched off,
  is code and configuration to explain for no benefit here.
- Demo data comes from a script (`pnpm db:seed`).

## Consequences

- `pnpm bootstrap` then `pnpm dev`, or `docker compose --profile full up`, is the whole setup.
- First-time setup still needs a network to install packages and pull images.
- Error reporting is the structured log with request ids.

## Alternatives rejected

- **Keep Sentry, off by default:** dead weight in a project that never runs in the cloud.
- **Remove the Razorpay adapter:** the webhook design would be shown only against a mock.
