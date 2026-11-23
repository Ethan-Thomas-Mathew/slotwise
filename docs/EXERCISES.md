# Exercises: make this project yours

Doing these is how you go from "I can read this code" to "I can change it under pressure", which is what an interviewer is really testing. Do them **in order**, each on its own git branch (`git switch -c ex1`), and only peek at the original when you're stuck.

Every exercise says how to check you got it right. Usually: the tests pass.

Before starting: `docker compose up -d`, then `pnpm test` should be all green.

---

## 1. Rewrite the slot generator (pure logic) ★★

**Goal:** Delete the body of `generateSlots()` in `apps/api/src/modules/availability/slots.ts` (keep the types and the function signature) and write it again yourself.

**Check:** `pnpm --filter @slotwise/api exec vitest run tests/unit/slots.test.ts`: all 31 tests pass.

**Hints:** Start with the simplest test ("09:00-12:00, 30 min → 6"). Make tests pass one at a time. Read the daylight-saving tests last.

## 2. See RLS save you ★

**Goal:** In `apps/api/src/modules/services/repo.ts`, remove `.where('tenant_id', '=', tx.tenantId)` from `getService`. Run the tenant isolation tests. They still pass. Why? Write the answer in one sentence.

Then put it back, and instead add `ALTER TABLE services DISABLE ROW LEVEL SECURITY;` in a new migration. Now remove the `where` again. What fails?

**Check:** You can explain why there are two layers and what each one catches. Delete the migration afterwards.

## 3. Reproduce the deadlock ★★

**Goal:** Comment out the `lockStaffCalendar(...)` line in `holdSlot` (`apps/api/src/modules/bookings/service.ts`). Run the concurrency test 5 times:

```bash
cd apps/api
for i in 1 2 3 4 5; do npx vitest run tests/integration/bookings.test.ts -t CONCURRENCY; done
```

Find the `deadlock detected` lines in the Postgres log (`docker compose logs postgres | grep -A5 deadlock`).

**Check:** You can explain why two inserts wait on each other, and why the lock fixes it. Then put the line back.

## 4. Add a "minimum notice" setting ★★★ (full stack)

**Goal:** Owners can say "customers must book at least N hours ahead".

You'll touch every layer:

1. a migration adding `tenants.min_notice_minutes` (default 0, CHECK 0–10080);
2. `src/db/schema.ts` and the schema test;
3. the shared `TenantSettingsPatch` schema;
4. the settings route and the settings page;
5. pass it into `generateSlots` as `minNoticeMinutes` (already supported!) in `availability/service.ts`.

**Check:** Add an integration test: set 48 hours, and slots for tomorrow are empty. All existing tests still pass.

## 5. CSV export of bookings ★★

**Goal:** `GET /bookings/export.csv` (owner only) returns the filtered bookings as CSV: date, time, customer, service, staff, status, amount. Add a "Download CSV" button on the owner bookings page.

**Watch out:** CSV injection. A customer named `=HYPERLINK(...)` must not become a formula in Excel. Prefix cells starting with `=`, `+`, `-` or `@` with `'`.

**Check:** An integration test for the content and the role guard (staff get 403), and one for the injection case.

## 6. Cache slot lookups and measure ★★★

**Goal:** Cache `/public/:slug/slots` responses in Redis for 10 seconds per (tenant, staff, service, date). Clear the cache for that staff member whenever one of their bookings is held, confirmed, cancelled, moved or expired.

**Check:** Run `pnpm --filter @slotwise/api bench` before and after, and record both in `docs/PERFORMANCE.md`. All booking tests must still pass. The concurrency test is the important one: a stale cache must never let two people book the same slot. (Why can't it?)

## 7. A no-show email ★

**Goal:** When staff mark a booking as no-show, email the customer ("We missed you…") using the notification outbox.

**Files:** the `notification_type` enum (new migration: `ALTER TYPE ... ADD VALUE`), `notifications/templates.ts`, `bookings/service.ts` (`markOutcome`).

**Check:** An integration test where `processNotification` sends it.

## 8. Deploy it ★★★

**Goal:** Follow `docs/DEPLOY.md`. Get a public URL, set up the Razorpay test webhook, and book and pay with a test card.

**Check:** The README's "Live" link works, and you've recorded the 2–3 minute walkthrough video.

---

When you can do 1, 3 and 4 without looking at the original code, you're ready to talk about this project in an interview.
