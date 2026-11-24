# Walkthrough

A plain-language record of each upgrade phase: what changed, why, and what else
could have been done. Written for someone still learning; read it top to bottom.

## Phase 0: Audit

**What happened.** Before changing anything, the whole repository was re-read and
checked: tests, lint, type-check, a production build, a tool that finds unused code
(`knip`), and text searches for things the project's rules forbid. The result is
`docs/AUDIT.md`: what the system actually is, and a ranked list of problems, each
with a file and line, why it matters, a proposed fix and a rough size.

**Why audit first.** Changing code you haven't measured tends to fix the wrong
things. An audit also gives the later work a checklist: every finding ends up fixed,
or deferred with a written reason.

**What was found, in short.** The core design (tenant isolation, double-booking
prevention, payment webhooks) held up. The problems were around it: rate limiting
that treats every Docker user as one person, missing timeouts, a few places where
errors were hidden, cloud-only pieces in a project meant to run offline, a `lib/`
folder used as a junk drawer, performance numbers measured on the wrong machine,
and development setup that takes too many steps.

**Decisions taken with the owner.** Remove Sentry and the cloud deployment guide;
keep the Razorpay adapter but off by default; keep the API-docs list and strengthen
its test rather than rewrite every route file.

**Alternative considered.** Fixing things as they were spotted while reading. Rejected:
it mixes unrelated changes into one commit and makes it impossible to say afterwards
what changed and why.

## Phase 2: Correctness and security fixes

Each fix started with a test that failed for the right reason, then the smallest
change that made it pass. One fix per commit.

**Rate limiting behind a proxy (C1).** The limiter counts attempts per IP address.
In Docker every request reaches the API from nginx, so every user had the same
address. For the reset-password page, which has no email in the request, that meant
five attempts per 15 minutes for the whole site. Two changes: the API is told how many
proxies sit in front of it (`TRUST_PROXY_HOPS`) and then reads the real address from
the `X-Forwarded-For` header; and reset links are counted per link. The alternative,
"always trust X-Forwarded-For", would let anyone pick a fake address and dodge the
limit, which is why a hop count is used and a test checks the header is ignored when
no proxy is configured.

**Errors that were hidden (C2, C3).** The forgot-password page said "a link is on its
way" even when the request failed. Saving a staff member's services turned every
database error into "service not found". Both now pass real failures on. The general
rule: catch an error only when you know what it means and can do something useful;
otherwise let it reach the error handler, which logs it with the request id.

**A wrong payment amount (C4).** If the payment provider reports a captured amount
different from the order, the booking must not be confirmed. The code used to throw,
which made the provider retry for a day an event that could never succeed. Now the
event is stored, acknowledged as `rejected`, written to the owner's activity log, and
an alert fires. Refunding it stays a human decision.

**Race conditions (C5, C6).** The "3 unpaid holds per customer" rule counted first and
inserted later. Two requests at the same moment both saw "2" and both inserted. A test
with six simultaneous requests produced up to six holds. The fix is a lock per customer
(a Postgres advisory lock, the same tool already used per staff calendar), taken before
counting. Account deletion takes the same lock, and a hold re-checks that the account
still exists after taking it, so a request in flight during a deletion can't book.

**Malformed webhooks (C7).** A correctly signed body that wasn't valid JSON caused a 500. The body is now parsed with a Zod schema after the signature check, so bad input
is a 400. This applies the project's rule: validate everything that comes from outside.

**Timeouts (S1).** Nothing limited how long a query, an open transaction or a slow
client could hold a database connection. With 10 connections in the pool, ten stuck
requests would stop the whole API. Postgres now cancels statements after 10 seconds and
ends transactions left idle for 30; connecting gives up after 5; clients have 30 seconds
to send a request. All four are settings with defaults.

**Smaller fixes.** The hold length shown to customers comes from one constant
(`HOLD_MINUTES`, now in the shared package) instead of "10" written in four places
(C8). The Mailpit image is pinned to a version, and a test rejects unpinned images
(S3). A request id sent by the caller is kept only if it is short and plain, so it
can't flood or forge log lines (S4, found during this phase).
