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
