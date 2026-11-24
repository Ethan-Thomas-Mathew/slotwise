# Deploying Slotwise

> **Status:** the Docker images are built in CI on every push, and the production bundle has been run locally. A live deployment has **not** been done yet. These are the steps to follow, and the things to check, when you do it.

## What you need

| Piece                 | Example providers                  | Notes                                                                                   |
| --------------------- | ---------------------------------- | --------------------------------------------------------------------------------------- |
| PostgreSQL 16         | Neon, Supabase, Render, Railway    | Must let you create a **second login role** (see below) and the `btree_gist` extension. |
| Redis 7               | Upstash, Render Key Value, Railway | Used by BullMQ and rate limiting.                                                       |
| 3 containers          | Render, Railway, Fly.io            | `api`, `worker`, `web`, all from the two Dockerfiles.                                   |
| SMTP                  | Resend, Postmark, Amazon SES       | Any SMTP credentials work (`SMTP_*`).                                                   |
| Razorpay test account | razorpay.com                       | Free. Gives `key_id`, `key_secret` and a webhook secret.                                |
| Sentry (optional)     | sentry.io                          | `SENTRY_DSN` for API/worker, `VITE_SENTRY_DSN` for the web build.                       |

## 1. Database roles (once)

Connect as the database's admin user and run (pick your own passwords):

```sql
CREATE ROLE slotwise_owner LOGIN PASSWORD '...';
CREATE ROLE slotwise_app   LOGIN PASSWORD '...' NOSUPERUSER NOBYPASSRLS;
GRANT ALL ON SCHEMA public TO slotwise_owner;           -- lets it create tables
ALTER DEFAULT PRIVILEGES FOR ROLE slotwise_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO slotwise_app;
ALTER DEFAULT PRIVILEGES FOR ROLE slotwise_owner GRANT USAGE, SELECT ON SEQUENCES TO slotwise_app;
ALTER DEFAULT PRIVILEGES FOR ROLE slotwise_owner GRANT EXECUTE ON FUNCTIONS TO slotwise_app;
CREATE EXTENSION IF NOT EXISTS btree_gist;              -- if only the admin may create extensions
```

Why two roles: Row-Level Security does not apply to a table's owner. The API must connect as `slotwise_app` (see `DECISIONS.md` D4).

## 2. Environment variables

API **and** worker (same values):

```
NODE_ENV=production
DATABASE_URL=postgresql://slotwise_app:...@host/db?sslmode=require
MIGRATION_DATABASE_URL=postgresql://slotwise_owner:...@host/db?sslmode=require
REDIS_URL=rediss://...
WEB_ORIGIN=https://your-domain        # the public URL of the web container
PAYMENTS_PROVIDER=razorpay
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
SMTP_HOST=... SMTP_PORT=587 SMTP_USER=... SMTP_PASS=...
EMAIL_FROM="Slotwise <bookings@your-domain>"
SENTRY_DSN=...                        # optional
# METRICS_HOST=0.0.0.0                # only if a private Prometheus must scrape :9464; never expose it publicly
# API_DOCS=true                       # interactive API docs are OFF in production unless you set this
```

Web container: `API_URL=http://<internal address of the api service>:3000`.

**Demo site without Razorpay:** set `PAYMENTS_PROVIDER=mock` and `ALLOW_MOCK_PAYMENTS=true`. Customers then see a "Pay (simulated)" button. Never do this on a real business's site.

## 3. Deploy order

1. Build and deploy the **api** image. Run the release command `node dist/migrate.js` (as a one-off job or "pre-deploy command").
2. Optionally seed demo data: `node dist/seed.js` (two demo businesses; every demo password is `password123`).
3. Deploy the **worker** from the same image with the command `node dist/worker.js`.
4. Deploy the **web** image and give it the public domain.
5. In the Razorpay dashboard add a webhook: `https://your-domain/api/webhooks/razorpay`, events `payment.captured`, `payment.failed`, `refund.processed`, and the same secret as `RAZORPAY_WEBHOOK_SECRET`.

## 4. Check it works

- `https://your-domain/api/ready` → `{"status":"ok", ...}`
- Log in with a demo account, book a slot and pay with a [Razorpay test card or UPI ID](https://razorpay.com/docs/payments/payments/test-card-details/).
- The booking turns **Confirmed** within a few seconds (webhook), and the confirmation email arrives.
- Cancel it: the refund appears in the Razorpay test dashboard.

## Things to watch

- **Cookies need HTTPS** in production (`Secure`), so the web container must be served over HTTPS (all the providers above do this).
- `trustProxy` is on in production, so rate limits see the real client IP behind the platform's load balancer.
- Run **one** reconciler: it is a BullMQ job scheduler, so several workers are safe (BullMQ runs each scheduled job once).
