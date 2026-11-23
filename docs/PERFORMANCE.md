# Performance

Measured with `pnpm --filter @slotwise/api bench` (`apps/api/scripts/bench.ts`). It starts the real API (real Postgres, real Redis/BullMQ), creates a throwaway business with 10 staff working around the clock and a few hundred customers, then sends concurrent HTTP requests.

**Machine:** one cloud VM with 2 vCPUs (Intel Xeon 2.1 GHz) and 8 GB RAM. The API, Postgres and Redis all share those 2 CPUs. A real deployment would put them on separate machines, so treat these as a floor, not a ceiling.

## Results (23 Nov 2026)

20 concurrent connections:

| Scenario                                         | Requests | Throughput | p50    | p95    | p99    | Outcome |
| ------------------------------------------------ | -------- | ---------- | ------ | ------ | ------ | ------- |
| `GET /public/:slug/slots`                        | 2,000    | ~320 req/s | 57 ms  | 96 ms  | 137 ms | all 200 |
| `POST /bookings/hold`, all on **1** staff member | 600      | ~120 req/s | 158 ms | 208 ms | 259 ms | all 201 |
| `POST /bookings/hold`, spread over **10** staff  | 600      | ~130 req/s | 150 ms | 210 ms | 237 ms | all 201 |

50 concurrent connections: throughput stays about the same (~255 reads/s, ~110–120 holds/s) and latency rises (p95 ≈ 280 ms for reads, ≈ 500–570 ms for holds). Once the CPUs are full, extra connections just queue.

Two runs at 20 connections differed by less than 5%.

## What the numbers say

- **The per-staff lock is cheap.** Funnelling every write through one staff member's lock (D19) costs only ~5–8% throughput compared with spreading the writes over 10 people. At this scale the bottleneck is CPU (Node and Postgres sharing 2 vCPUs), not lock waiting.
- **Plenty for the target users.** A busy salon takes maybe a few dozen bookings a day. ~120 holds per second is over 400,000 per hour on one small machine.
- **Reads are the hot path.** Every visit to a booking page asks for slots. If this ever needed to scale, the obvious steps are:
  1. cache `/slots` for a few seconds per (staff, date), invalidated on any booking change;
  2. load the tenant, service and staff in one query instead of four;
  3. run more API instances (the app is stateless; sessions and rate limits are in Postgres/Redis).

## How to run it

```bash
docker compose up -d && pnpm db:migrate
pnpm --filter @slotwise/api bench                          # 20 connections
BENCH_CONCURRENCY=50 pnpm --filter @slotwise/api bench     # heavier
```
