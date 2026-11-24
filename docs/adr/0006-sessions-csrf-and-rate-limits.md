# 0006. Server-side sessions, CSRF tokens and rate limits

Status: accepted (November 2026)

## Context

Signup must create a tenant, a user and a membership in one transaction under RLS, and
staff invites have their own rules. Sessions must be revocable (a password reset should
log out every device).

## Decision

- **Sessions:** a random 32-byte token in an `httpOnly`, `SameSite=Lax` cookie. Only its
  SHA-256 hash is stored, in `sessions`. Passwords use Argon2id via `@node-rs/argon2`; no
  cryptography is written by hand.
- **CSRF:** each session has its own random token, sent by the frontend as `x-csrf-token`
  on every write and compared in constant time. Writes also reject a foreign `Origin`.
- **Enumeration:** login gives the same error, after the same hashing time, for an unknown
  email and a wrong password; forgot-password always says the link is on its way.
- **Rate limits:** 5 attempts per 15 minutes per route, client IP and target (the email, or
  a hash of the one-time token on routes without an email), counted in Redis. The client
  IP comes from `X-Forwarded-For` only through the configured number of proxies
  (`TRUST_PROXY_HOPS`, 1 in Docker). Before that setting existed, every Docker user shared
  nginx's address and therefore one budget.

## Consequences

- About 100 lines of session code that can be explained line by line.
- We own expiry, clean-up and any future OAuth or MFA.
- An attacker rotating IPs against one email isn't stopped by the limiter alone.

## Alternatives rejected

- **JWTs:** can't be revoked before they expire without a server-side list, which is a
  session table again.
- **An auth framework (Better Auth, Passport):** the tenant-creating signup and invite rules
  would live inside its hooks, harder to follow than plain code.
- **Trusting `X-Forwarded-For` unconditionally:** any client could choose its own address.
