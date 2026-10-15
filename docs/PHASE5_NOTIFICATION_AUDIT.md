# Phase 5 — Task 5.1 Notification Scheduling Audit

วันที่ตรวจ: 15 ตุลาคม 2026
สถานะ: Audit เท่านั้น — ยังไม่แก้ Application Code, Database, Edge Functions, Cron หรือ Production Configuration

## Executive Summary

ระบบเดิมใช้ `pg_cron` ตัวอย่างทุก 5 นาทีเรียก `send-reminders` ผ่าน `pg_net` แล้ว query view `reminder_candidates` ซึ่งคำนวณกำหนดส่งจาก `shifts × reminders` ทุกครั้ง ระบบมี atomic claim, delivery log, retry สูงสุด 3 ครั้ง และ stable LINE retry key อยู่แล้ว แต่ยังรองรับเฉพาะ reminder แบบ offset ก่อนทุกเวร ไม่รองรับ one-time/daily/weekly/monthly job, cancellation/rescheduling generation, recipient-level attempts หรือ recovery หลังระบบหยุดเกิน 30 นาที

แนวทาง V2 ที่เสนอคือ **Postgres notification job queue + indexed due-job claim + Supabase Cron worker** โดย materialize jobs เมื่อข้อมูลเปลี่ยน แทนการคำนวณ candidate ทั้งหมดทุก polling รอบ ใช้ cron เดิมในช่วง Shadow Mode และเพิ่ม external scheduler adapter boundary ไว้ แต่ยังไม่เพิ่มผู้ให้บริการภายนอก เนื่องจากระบบขนาดเล็กและ Supabase ที่มีอยู่รองรับ worker แบบ recurring ได้โดยไม่มี vendor ใหม่

ต้องสืบสวน metric anomaly แยกต่างหากก่อน cutover: remote มี request setup ประมาณ 30.5 ล้าน calls และ `user_settings` sequential scans ประมาณ 29.7 ล้านครั้งในช่วง stats ประมาณ 11.5 ชั่วโมง ซึ่งไม่สามารถเกิดจาก cron ทุก 5 นาทีเพียงอย่างเดียว จึงห้ามสรุปว่า notification cron เป็น root cause

## 1. Current Notification Architecture

```text
ผู้ใช้แก้ Settings/Shift ใน LIFF
  -> app-api ตรวจ LINE ID token
  -> replace_user_state_v2
  -> user_settings / reminders / shifts

Supabase pg_cron (ตัวอย่าง */5 นาที)
  -> pg_net HTTP POST + apikey + x-cron-secret
  -> send-reminders Edge Function
  -> reminder_candidates view (Asia/Bangkok)
  -> claim_notification_delivery RPC
  -> notification_logs
  -> LINE Push API + X-Line-Retry-Key
```

### Component inventory

| Component | สถานะใน Repository | หมายเหตุ |
|---|---|---|
| `reminders` | มี | offset 5–43,200 นาทีต่อผู้ใช้ ใช้กับทุกเวร |
| `user_settings.notifications_enabled` | มี | master switch |
| `reminder_candidates` | มี | view คำนวณ `notify_at` จาก date/time และ timezone Asia/Bangkok |
| `notification_logs` | มี | unique `(shift_id, reminder_id)`, status, attempts, retry time |
| `claim_notification_delivery` | มี | atomic insert/reclaim failed หรือ stale pending |
| `send-reminders` | มี | cron-secret auth, LINE push, retry สูงสุด 3 ครั้ง |
| `cron.sql.example` | มี | ตัวอย่าง `*/5 * * * *` ผ่าน Vault และ pg_net |
| Vercel Cron | ไม่มี | `vercel.json` ไม่มี `crons` |
| Independent job/rule model | ไม่มี | ยังไม่มี one-time/recurrence/cancel/reschedule |
| External scheduler | ไม่มี | ยังไม่มี adapter/provider |
| Expiration notification | ยังไม่มี | Phase 6 ต้อง reuse V2 |

Phase 4 LINE webhook เป็น event-driven คนละเส้นทางกับ shift push และต้องไม่ถูกเปลี่ยนใน Phase 5

## 2. Existing Scheduling and Delivery Flow

1. ผู้ใช้บันทึก reminder offsets และ shifts ผ่าน full-state transaction
2. view สร้าง candidate เฉพาะผู้ใช้ที่เปิด master switch และ reminder ที่ enabled
3. worker query ช่วง `now - 30 นาที` ถึง `now + 4 นาที`
4. แต่ละ candidate ถูก claim ด้วย unique shift/reminder key
5. workerอ่าน delivery row อีกครั้งเพื่อรับ UUID เป็น LINE retry key
6. เมื่อ LINE สำเร็จ mark `sent`; เมื่อไม่สำเร็จ mark `failed` และ retry หลัง 5/10 นาที
7. pending claim เกิน 10 นาทีสามารถ reclaim ได้

### Existing strengths

- เวลาเวรคำนวณด้วย `Asia/Bangkok`
- master switch และ per-reminder switch มีอยู่แล้ว
- service-role อยู่เฉพาะ backend; frontend ไม่มี privileged secret
- Edge Function ตรวจ `x-cron-secret`
- atomic claim และ unique constraint ป้องกัน concurrent duplicate ระดับหนึ่ง
- LINE retry key คงเดิมในแต่ละ delivery
- log ไม่บันทึก channel token หรือเงินเดือน

### Gaps and correctness risks

1. Query view คำนวณ joins และ `notify_at` ใหม่ทุกครั้ง ไม่ใช่ indexed due-job queue
2. worker อาจส่งเร็วได้สูงสุดประมาณ 4 นาที เพราะ query รวม candidate ในอนาคต
3. downtime เกิน 30 นาทีทำให้ candidate หลุด window และไม่มี recovery path
4. retry ทุก non-2xx โดยไม่จำแนก permanent 4xx กับ transient 429/5xx
5. LINE `409` จาก retry key ที่เคย accepted ควรตีความเป็น accepted duplicate แต่ระบบเดิม mark failed
6. fetch ไม่มี explicit timeout; ambiguous outcome พึ่ง runtime timeout
7. ถ้า LINE รับข้อความแล้วแต่ update log ล้มเหลว รอบถัดไปอาจถูก mark failed แม้ retry key ป้องกันข้อความซ้ำ
8. ไม่มี rule generation/version จึงป้องกัน stale callback หลังแก้เวลาหรือ cancel ไม่ได้
9. ไม่มี delivery attempt history แยกรอบ มีเพียงสถานะล่าสุดใน row เดียว
10. reminder offset เป็น recurrence จากทุก shift เท่านั้น ยังไม่ใช่ one-time/daily/weekly/monthly schedule
11. ไม่มี metrics สำหรับ due/claimed/sent/failed/latency และไม่มี dead-letter state ที่ชัดเจน

## 3. Remote Read-Only Baseline

อ่านผ่าน Supabase CLI โดยไม่แก้ข้อมูล:

| Metric | ค่า |
|---|---:|
| Database size | 12 MB |
| Table hit rate / Index hit rate | 100% / 100% |
| Stats age | ประมาณ 11 ชั่วโมง 28 นาที |
| Profiles | 2 rows |
| Shifts | 25 rows |
| Reminders | 4 rows |
| Notification logs | 0 rows |
| `set_config(...)` request setup | 30,532,017 calls, 93.5% ของ measured execution time |
| `user_settings` sequential scans | 29,746,307 |
| `user_settings` primary-key index scans | 758,638 |
| pg_net queue worker callsที่เห็น | 182 |

### Interpretation constraints

- ไม่มี direct CPU percentage จาก CLI จึงยังวัด CPU before/after ไม่ได้
- จำนวน row เล็กมากและ cache hit 100% ดังนั้น current data volume ไม่ใช่คอขวด
- request/scan anomaly สูงกว่าความถี่ 5 นาทีหลายลำดับขั้น ต้องตรวจ API/Edge Function logs และ Dashboard CPU ก่อน attribution
- `notification_logs = 0` ทำให้ยังไม่มีหลักฐาน delivery/retry จริงใน production
- repository มี cron SQL เพียง “ตัวอย่าง”; audit ยังยืนยัน row จริงใน `cron.job` ไม่ได้ เพราะ environment ไม่มี Docker/psql สำหรับ safe dump
- net worker calls บอกว่า pg_net ทำงาน แต่ไม่พิสูจน์ว่าเป็น job `send-nurse-shift-reminders`
- remote มี hardening indexes/columns ของ migration 002 แต่ migrations 003–005 ยัง pending จาก dry-run ก่อนหน้า

## 4. Proposed V2 Architecture

### Selected baseline: Indexed database queue

```text
State mutation / rule mutation
  -> validate owner + timezone + recurrence
  -> upsert notification_rule generation N
  -> materialize notification_jobs(scheduled_for UTC, idempotency_key)

Supabase Cron worker (แนะนำทุก 1 นาทีหลัง shadow ผ่าน)
  -> atomic claim เฉพาะ indexed due jobs
  -> process job ID + validate rule generation/status/recipient
  -> LINE push ด้วย stable UUID retry key
  -> delivery attempt result
  -> schedule next recurrence เมื่อสำเร็จ

Low-frequency recovery (แนะนำทุก 30–60 นาที)
  -> indexed query เฉพาะ overdue/retry/expired lease
```

ข้อดี:

- ไม่ scan/join เวรทั้งหมดทุก 5 นาที
- query หลักเป็น partial index บน due time
- รองรับ one-time, daily, weekly, monthly และ shift offset ด้วย model เดียว
- cancel/reschedule ได้ด้วย rule generation; stale callback ส่งไม่ได้
- Phase 6 ใช้ job/delivery infrastructure เดิมได้
- ไม่มี external vendor หรือค่าใช้จ่ายใหม่

ข้อแลกเปลี่ยน:

- ยังมี lightweight polling หนึ่ง indexed query ต่อรอบ
- ความแม่นยำขึ้นกับ cron interval และ queue latency
- ต้องสร้าง jobs ใหม่เมื่อ shift/reminder เปลี่ยน

### Scheduler adapter boundary

กำหนด interface ตั้งแต่แรก แม้ production เริ่มด้วย database worker:

- `register(job)`
- `cancel(providerRef)`
- `verifyInvocation(request)`
- `provider = database | qstash`

External callback ต้องส่งเฉพาะ opaque job ID + generation ห้ามเชื่อ recipient หรือ payload ส่วนตัวจาก callback

## 5. Architecture Alternatives and Cost

ข้อมูลราคา/ข้อจำกัดตรวจจากเอกสารทางการวันที่ audit:

| ทางเลือก | ค่าใช้จ่าย/ข้อจำกัด | การตัดสินใจ |
|---|---|---|
| Supabase Cron + indexed queue | ใช้ project/compute เดิม; Supabase แนะนำไม่เกิน 8 jobs พร้อมกันและแต่ละ jobไม่เกิน 10 นาที | **แนะนำ** สำหรับระบบนี้ |
| pg_cron หนึ่ง job ต่อ notification | ไม่มี vendor เพิ่ม แต่สร้าง/ยกเลิก cron rows จำนวนมากและ concurrency/operations ซับซ้อน | ไม่แนะนำ |
| Upstash QStash | Free 1,000 messages/day, max delay 7 วัน, 10 active schedules; Pay-as-you-go $1/100K delivery attempts, delayสูงสุด 1 ปี และ retriesคิดเป็น messages | Adapter ทางเลือกเมื่อ scale/precision ต้องการจริง |
| Vercel Cron Hobby | รันได้ขั้นต่ำวันละครั้งและ precision ±59 นาที; Pro จึงรองรับรายนาที | ไม่เหมาะกับแจ้งเตือนเวร |

Sources:

- Supabase Cron: https://supabase.com/docs/guides/cron
- Upstash QStash pricing: https://upstash.com/pricing/qstash
- Upstash delayed delivery: https://upstash.com/docs/qstash/overall/usecases
- Vercel Cron usage/pricing: https://vercel.com/docs/cron-jobs/usage-and-pricing
- LINE retry semantics: https://developers.line.biz/en/docs/messaging-api/retrying-api-request

ยังไม่เสนอให้เปิด QStash หรือบริการเสียเงินใน Task 5.2

## 6. Database Migration Plan

Migration แบบ additive และไม่ลบ records เดิม:

### `notification_rules`

- UUID PK, `user_id`, notification type
- schedule kind: `one_time | daily | weekly | monthly | shift_offset`
- timezone default `Asia/Bangkok`
- schedule configuration ที่ validate แล้ว
- enabled, generation, timestamps
- optional source shift/reminder references

### `notification_jobs`

- UUID PK, rule/user/type
- `scheduled_for timestamptz`, status, generation
- unique idempotency key
- attempts, `next_attempt_at`, `lease_token`, `leased_until`
- scheduler provider/reference
- minimal payload; ไม่เก็บ salary
- partial index `(coalesce(next_attempt_at, scheduled_for))` สำหรับ pending/retry

### `notification_deliveries`

- UUID PK, job/recipient
- stable LINE retry UUID
- attempt number, status, HTTP status, LINE request IDs
- started/completed timestamps และ sanitized error code
- unique recipient-level idempotency constraint

### Compatibility

- เก็บ `reminders`, `notification_logs`, `reminder_candidates` และ legacy RPC ไว้ตลอด Shadow Mode
- backfill rules/jobs แบบ `shadow` จาก shifts/reminders โดยไม่ส่งจริง
- ห้ามเปิด legacy และ V2 delivery พร้อมกันสำหรับ recipient/job เดียวกัน
- RLS enabled และ revoke browser roles; service role / narrow RPC เท่านั้น

## 7. Delivery and Retry Policy

- Atomic claim ใช้ transaction/`FOR UPDATE SKIP LOCKED` พร้อม lease
- ตรวจ job status, rule enabled, generation, user และ LINE recipient จาก DB ก่อนส่ง
- `X-Line-Retry-Key` ต้องสร้างก่อน request แรกและใช้ UUID เดิมทุก retry
- Treat LINE `200` เป็น accepted
- Treat `409` พร้อม accepted request ID เป็น accepted/idempotent success
- Retry เฉพาะ timeout, network, `429`, และ `5xx` ตาม policy
- ไม่ retry permanent `4xx` เช่น invalid recipient/payload โดยอัตโนมัติ
- exponential backoff + jitter ภายใต้ max attempts
- ambiguous outcome ใช้ retry key เดิมเท่านั้น
- เก็บ attempt ทุกครั้งโดยไม่ log token, recipient raw ID หรือ salary

## 8. Shadow, Cutover and Rollback

### Shadow

1. Apply additive tables/functions/indexes
2. เปิด `V2_SHADOW=true`, `V2_DELIVERY=false`
3. materialize jobs และเปรียบเทียบ legacy candidates กับ V2 jobs
4. ตรวจ due counts, lateness, duplicate keys และ query cost
5. legacy cron ยังส่งตามเดิม

### Controlled cutover

1. เลือก test users ก่อน
2. ตั้ง per-user delivery mode เป็น `v2`
3. legacy worker ต้อง exclude users ที่เป็น V2 ก่อนเปิด V2 delivery
4. เปิด V2 delivery และติดตาม accepted/failed/late/duplicate metrics
5. ขยายทีละกลุ่มหลังผ่านเกณฑ์

### Rollback

1. ปิด V2 delivery flag ทันที
2. เปลี่ยนผู้ใช้กลับ `legacy`
3. เปิด/คง legacy cron เดิม
4. V2 pending jobs เปลี่ยนเป็น suspended/cancelled โดยไม่ลบ history
5. ไม่ rollback additive schema ระหว่าง incident
6. reconcile accepted LINE deliveries ก่อน resend เพื่อป้องกันซ้ำ

## 9. Task 5.2–5.8 Proposed Work Order

1. สืบสวน request/scan anomaly ผ่าน Supabase API/Edge logs และ CPU chart
2. เพิ่ม additive V2 schema, claim/reschedule/cancel RPC และ indexes
3. สร้าง pure scheduling engine สำหรับ one-time/daily/weekly/monthly/shift-offset พร้อม timezone tests
4. เพิ่ม event-driven materialization หลัง state/rule mutation
5. แยก LINE delivery service และ status-aware retry policy
6. เพิ่ม worker by job ID, batch due worker และ signed scheduler authorization
7. เพิ่ม recovery worker ที่ query เฉพาะ indexed stale/due jobs
8. เปิด local Shadow Mode tests; legacy path ยังเป็น default
9. ทดสอบ 20 cases ตาม Prompt 4 รวม concurrency และ stale callbacks
10. เก็บ query plan/baseline หลัง schema ใน local/isolated environment
11. จัดทำ controlled production checklist แต่ไม่ deploy/cutoverจนกว่าจะได้รับอนุญาตแยก

## 10. Audit Gate and Open Evidence

Task 5.1 เสร็จเมื่อส่งเอกสารนี้ แต่ Phase 5 ยังไม่เสร็จ ต้องได้รับอนุมัติก่อน Task 5.2

หลักฐานที่ยังต้องเก็บก่อน production:

- cron jobs และ run history จริงจาก Supabase Dashboard (`cron.job`, `cron.job_run_details`)
- Edge Function invocation/error logs ของ `send-reminders`
- Supabase CPU chart และช่วงเวลาที่เกิด 30.5M request anomaly
- API gateway/PostgREST request source ที่สัมพันธ์กับ `user_settings` scans
- controlled LINE test identity และ isolated/staging strategy

ไม่มี Application Code, Database, Cron, Edge Function หรือ Production Configuration ถูกเปลี่ยนใน Task 5.1
