# 0014. Account erasure anonymises instead of deleting

Status: accepted (November 2026)

## Context

India's Digital Personal Data Protection Act (2023) gives people the right to a copy of
their data and to erasure. Each business must still keep booking and payment records for
its accounts.

## Decision

- **Export:** `GET /account/data` returns the person's profile, memberships, bookings and
  payments as a file.
- **Erasure:** `POST /account/delete` requires the password and the typed word `DELETE`.
  It is refused for owners (a business can't lose its owner), team members (the owner
  removes them first) and anyone with upcoming bookings (cancel first, so refunds
  happen).
- In one transaction: the name, email and password are replaced, `deleted_at` is set, all
  sessions and tokens are deleted, the email is removed from old audit entries (through one
  narrow `SECURITY DEFINER` function, because the app can't update the audit log), and each
  business gets an audit entry with no personal data.
- Erasure takes the same per-customer lock as holding a slot, and a hold re-checks the
  account after taking it, so a request in flight can't book for an erased account.

## Consequences

- Past bookings remain and show "Deleted user".
- Payment-provider webhook payloads are kept as financial records; logs expire on their own.
- Closing a whole business isn't self-service.

## Alternatives rejected

- **Deleting the user row:** breaks booking and payment history the business must keep.
- **Soft delete only (a flag):** the person is still identifiable.
