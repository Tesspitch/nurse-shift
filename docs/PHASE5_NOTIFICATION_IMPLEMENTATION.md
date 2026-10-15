# Phase 5 — Notification Scheduling V2 Implementation

วันที่: 15 ตุลาคม 2026  
สถานะ: Implemented locally, legacy remains default, not deployed

## Architecture

V2 ใช้ PostgreSQL job queue แบบ indexed และ Supabase Edge Function worker เดิม โดยไม่เพิ่มบริการเสียเงิน:

```text
app-api / state mutation
  -> notification_rules (generation + timezone + recurrence)
  -> notification_jobs (shadow by default)

approved cron / signed callback
  -> atomic claim with FOR UPDATE SKIP LOCKED + five-minute lease
  -> send-reminders
  -> LINE push with stable retry key
  -> notification_deliveries + next recurrence/retry

low-frequency recovery
  -> expired leases only
  -> indexed due-job claim
```

Legacy `reminder_candidates`, `notification_logs`, claim RPC และ cron เดิมยังอยู่ครบ ผู้ใช้ทุกคนเริ่มที่ `shadow`; V2 จะส่งจริงเฉพาะผู้ใช้ที่ถูกสลับเป็น `v2` ผ่าน service-role RPC เท่านั้น

## Delivered Scope

- One-time, daily, weekly, monthly และ shift-offset rules
- Timezone-aware next-run calculation; default `Asia/Bangkok`
- Additive tables: rules, jobs, deliveries และ per-user delivery mode
- Unique idempotency keys, stable LINE retry key, recipient-level attempt history
- Atomic claim, lease expiry, retry/backoff, dead state และ indexed recovery
- Cancellation/rescheduling ด้วย generation; stale callbacks claim ไม่ได้
- Cron-secret authentication และ HMAC-signed external callback option
- LINE timeout handling; retry เฉพาะ network/timeout/408/429/5xx
- LINE 409 ถือว่าสำเร็จเฉพาะเมื่อมี `x-line-accepted-request-id`
- Legacy remains the default route; `reminder_candidates` excludes only controlled V2 users
- Accepted V2 shift reminder writes compatibility state to legacy logs for safe rollback
- Scheduler adapter supports database mode and an optional external HTTP provider boundary

## Database and Security

- ทุก V2 table เปิด RLS และ revoke `anon`/`authenticated`
- RPC ใช้ `security invoker` และให้สิทธิ์เฉพาะ `service_role`
- Recipient is loaded from the authorized profile in Database, never trusted from callback payload
- Jobs contain only minimum notification payload; no salary data is written to operational logs
- No destructive operation drops legacy tables, logs or cron configuration

## Feature Modes

- `legacy`: legacy candidate view sends; V2 active jobs are cancelled
- `shadow`: legacy sends; V2 materializes comparable jobs but never claims them
- `v2`: legacy view excludes that user and V2 jobs become claimable

Controlled switch:

```sql
select public.set_notification_delivery_mode_v2('PROFILE_UUID', 'v2');
```

Rollback:

```sql
select public.set_notification_delivery_mode_v2('PROFILE_UUID', 'legacy');
```

## Worker Modes

- `{}`: existing legacy behavior (default)
- `{"mode":"v2-batch"}`: claim indexed due jobs
- `{"mode":"v2-job","jobId":"...","generation":1}`: process one scheduler callback
- `{"mode":"v2-recovery"}`: recover expired leases and claim due work

## Environment Variables

Existing:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEYS` or `SUPABASE_SERVICE_ROLE_KEY`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `REMINDER_CRON_SECRET`

Optional only for an external signed scheduler:

- `SCHEDULER_SIGNING_SECRET`

No frontend variable contains a privileged credential.

## Controlled Deployment Order

No step below has been run in Production.

1. Apply migration `202610150006_notification_scheduling_v2.sql`.
2. Deploy `app-api` and `send-reminders` together.
3. Keep every user in `shadow`; keep legacy cron unchanged.
4. Compare shadow jobs with legacy candidates, due time, duplicate keys and query plans.
5. Investigate the previously observed request/scan anomaly independently.
6. Add the V2 due/recovery cron from `supabase/cron-v2.sql.example` only after approval.
7. Switch one controlled test profile to `v2`.
8. Verify delivery, retries, cancellation, lateness and compatibility logs.
9. Expand gradually or call rollback RPC immediately if thresholds fail.

## Rollback

1. Switch affected profiles to `legacy`.
2. V2 pending/retry/leased jobs are cancelled without deleting history.
3. Keep the legacy cron active throughout rollout.
4. Do not drop additive schema during an incident.
5. Reconcile accepted LINE request IDs before any manual resend.

## Verification

Unit/contract tests cover scheduling kinds, Bangkok timezone, DST gap, rescheduling generation, cancellation, stale callback, stable idempotency, LINE success/409/timeout/429/5xx/permanent 4xx, signed authorization, scheduler registration failure, RLS contract, partial indexes, atomic claim and legacy default routing.

Connected Database concurrency, real LINE delivery, Supabase CPU charts and cron run history remain intentionally untested until an isolated/controlled deployment is authorized. E2E browser tests were not run per the latest user instruction.

## Performance Expectation and Measurement

The legacy path computes a joined candidate view every poll. V2 uses a partial due index on `coalesce(next_attempt_at, scheduled_for)` and an expired-lease partial index. This should reduce query work to due rows, but no Production improvement is claimed until `EXPLAIN (ANALYZE, BUFFERS)`, Edge invocation metrics and Supabase CPU are captured during Shadow Mode.

