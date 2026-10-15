# NurseShift Implementation Plan

เอกสารนี้จัดทำจาก Repository Audit ณ วันที่ 15 ตุลาคม 2026 และใช้ `prompt.md` เป็น Requirements หลัก

สถานะเอกสาร: **Implementation tracker — Phase 1–3 completed locally, not deployed**

ข้อจำกัดของรอบงานนี้:

- ยังไม่แก้ Application Code
- ยังไม่แก้ Database Schema หรือข้อมูลจริง
- ยังไม่แก้ Supabase Edge Functions, Cron Jobs, LINE Configuration หรือ Vercel Configuration
- ยังไม่ Deploy Production
- ทุก Phase ต้องได้รับคำสั่งก่อนเริ่ม และต้องหยุดรอคำสั่งก่อน Phase ถัดไป

## 1. Executive Summary

NurseShift ปัจจุบันเป็น Mobile-first LIFF web application ที่สร้างด้วย Vite และ Vanilla JavaScript ไม่ใช่ React + TypeScript ตามข้อความใน Master Prompt ส่วน Backend เป็น Supabase Edge Functions ที่เขียนด้วย TypeScript/Deno และใช้ PostgreSQL เป็นฐานข้อมูล

ระบบที่มีอยู่แล้วครอบคลุม Onboarding, ตารางเวรแบบรายรายการ, การคำนวณรายได้โดยประมาณ, OT อัตโนมัติ, OT เคสด่วนที่ผูกกับเวร, รายรับ/รายการหัก, PDF/CSV/JSON, LINE Login, การบันทึกข้อมูลผ่าน Edge Function และการแจ้งเตือนเวรด้วย Cron ทุก 5 นาที

สิ่งที่ยังไม่ครบตาม Master Plan ได้แก่ Special OT ที่เป็นรายการอิสระ, Bulk Shift/Multi-date, Day Off, Historical Data 3 เดือนแบบเลือกเดือน, Rich Menu หน้า 2, LINE webhook/postback, Notification Scheduling V2, Data Expiration Notifications และ E2E test suite

## 2. Current Architecture

### 2.1 Runtime Flow

```text
LINE LIFF / Browser
  -> Vite frontend (Vanilla JS, HTML, CSS)
  -> LIFF SDK obtains LINE ID token
  -> Supabase Edge Function: app-api
  -> LINE token verification endpoint
  -> Supabase PostgreSQL through service-role client

Supabase pg_cron (example: every 5 minutes)
  -> Edge Function: send-reminders
  -> reminder_candidates view
  -> atomic delivery claim RPC
  -> LINE Messaging API push
  -> notification_logs
```

### 2.2 Frontend

| Area | Current implementation |
|---|---|
| Framework | Vite 8 + Vanilla JavaScript ES modules |
| Entry | `index.html`, `src/app.js` |
| Styling | `src/styles.css` |
| State | One in-memory state object; Local mode persists to `localStorage` |
| Remote persistence | Entire state is submitted to `app-api` using `replace-state` |
| Authentication | LIFF SDK obtains ID token; token sent in `x-line-id-token` |
| Calendar | 42-cell monthly calendar; previous/next month navigation is currently unlimited |
| Date display/input | Buddhist Era display; input supports `dd/mm/yyyy` and native date picker |
| Payroll | Client-side calculation in `src/calculations.js` |
| Export | CSV, JSON backup/restore, client-generated PDF |
| Navigation | SPA-style screen switching plus Rich Menu deep-link query parameters |

Important mismatch: the Master Prompt names React + TypeScript as the frontend stack, but the repository is Vanilla JavaScript. A framework migration is not required by the business rules and should not be mixed into Phase 1–3 without separate approval.

### 2.3 Backend and API

`supabase/functions/app-api/index.ts` currently supports:

- `bootstrap` — load the complete user state
- `replace-state` — validate and replace the complete user state with optimistic concurrency
- `test-notification` — rate-limited LINE test push
- `delete-account` — delete the profile and cascade user data

Security flow:

1. Browser sends a LINE ID token.
2. Edge Function verifies it with LINE using `LINE_LOGIN_CHANNEL_ID`.
3. LINE `sub` maps to `profiles.line_user_id`.
4. Edge Function uses backend Supabase credentials.
5. All queries include the resolved profile ID.

The Edge Functions have Supabase JWT verification disabled because they implement LINE-token or Cron-secret verification themselves. This is intentional but makes those custom checks security-critical.

### 2.4 Database

| Object | Purpose | Audit observation |
|---|---|---|
| `profiles` | LINE identity and display profile | `line_user_id` is unique |
| `user_settings` | Salary, OT rate, standard hours, payroll cycle and notification master switch | `standard_hours` defaults to 176 but is user-configurable |
| `shift_types` | User-specific shift name, time, premium and color | Morning/evening/night defaults exist |
| `shifts` | Work date, shift type, time, urgent OT and note | No Day Off representation and Special OT is tied to a shift |
| `financial_items` | Additional income and deductions | Included in complete-state replacement |
| `reminders` | Per-user reminder offsets | One-time offsets relative to every shift, not independent schedules |
| `notification_logs` | Delivery claim/status/retry state | Unique by shift and reminder |
| `reminder_candidates` | Shift reminder schedule projection | Calculates `notify_at` in Asia/Bangkok |

Current indexes:

- `shifts(user_id, work_date)`
- `financial_items(user_id, work_date)`
- `notification_logs(shift_id)`
- Partial retry index on `notification_logs(status, next_attempt_at)`

RLS and authorization:

- RLS is enabled on all application tables.
- `anon` and `authenticated` have table access revoked.
- No direct browser-to-table access is used.
- Edge Functions use backend credentials and perform user scoping themselves.
- Existing RLS/revocation and service-role isolation must be preserved through every migration.

### 2.5 Payroll and OT Logic

Current implementation in `src/calculations.js`:

```text
workedHours = sum(floored duration of shifts in payroll cycle)
automaticOtHours = max(0, workedHours - settings.standardHours)
urgentOtHours = sum(floored urgentOtHours stored on shifts)
otIncome = (automaticOtHours + urgentOtHours) * otRate
gross = salary + license allowance + shift premiums + OT income + other income
net = gross - deductions
estimate range = net ± uncertainty buffer
```

Confirmed behavior:

- Overnight shifts are supported.
- Partial hours are floored to full hours.
- Default standard hours are 176.
- Default evening premium is 200 baht.
- Default night premium is 300 baht.
- Payroll cycle start is configurable from day 1–28 and defaults to day 25.

Gaps or decisions required for Phase 1:

- Special OT is currently `urgentOtHours` inside a shift; it cannot exist independently.
- `standardHours` is configurable, while the highest-priority prompt specifies the 176-hour rule. This must be resolved before changing calculation behavior.
- Overlapping shifts show a warning but both shifts still contribute full hours, creating a possible double-counting risk.
- Full-state replacement makes narrowly scoped OT updates harder to reason about and test.

### 2.6 Calendar and Day Off

Current behavior:

- Calendar supports collapsed/expanded visual modes.
- Multiple shift records can exist on the same date.
- Selecting a calendar date immediately opens the single-shift form.
- Shift overlaps display a warning but do not block saving.
- There is no bulk selection, preview, batch save or Day Off status.

Requirement mismatch:

- Master Phase 2 requires tapping a date to show details only.
- Adding shifts must occur from the bottom “เพิ่มเวร” action.
- Bulk selection must retain selections across morning/evening/night/Day Off categories.

### 2.7 Historical Data

The frontend currently receives all shifts and financial items for the user. Calendar month navigation is not limited to three months, while the finance summary is tied to the current payroll cycle rather than a selected historical calendar month.

There is no month-scoped API, month cache or Current Month + Previous 2 Months selector. No current code deletes data merely because it leaves the display range, which must remain true.

### 2.8 LINE Integration

Existing:

- LIFF login and profile retrieval
- Friendship status check when available
- Test push message
- Main Rich Menu JSON with four URI/deep-link areas
- Deep links for home, calendar, settings and add-shift

Missing for Phase 4:

- Rich Menu page 2 asset/configuration
- Rich Menu aliases and switching flow
- Messaging API webhook endpoint
- Raw-body `x-line-signature` verification
- Postback handlers for the six required actions
- Flex Message templates and duplicate webhook protection

The main Rich Menu configuration must be treated as immutable unless the user explicitly approves a navigation approach that needs an available area.

### 2.9 Notification Scheduler

Current scheduler design:

- `supabase/cron.sql.example` documents a `*/5 * * * *` pg_cron schedule.
- Cron calls `send-reminders` using an `x-cron-secret`.
- The function queries candidates in a time window, claims each delivery atomically, uses a stable LINE retry key and retries at most three attempts.
- Stale pending claims can be reclaimed after ten minutes.

Current strengths:

- Secret-protected invocation
- Unique delivery constraint
- Atomic claim RPC
- Retry state and stable LINE retry key
- No secrets in the frontend

Phase 5 gaps:

- Still polling every five minutes.
- No notification rules/jobs/deliveries model for independent one-time or recurring schedules.
- No scheduler adapter, cancellation, rescheduling or stale-callback model.
- No shadow-mode/feature-flag cutover implementation.
- No measured CPU/query baseline is stored in the repository.
- The computed reminder view does not expose evidence of an indexable due-job queue.

The audit cannot confirm the actual production Cron configuration or Supabase CPU metrics from repository files alone. Those must be inspected read-only in the relevant dashboards during Phase 5 Task 5.1.

### 2.10 Testing and Build Baseline

Available commands:

- `npm test` — Node built-in unit tests
- `npm run build` — Vite production build

Audit results on 15 October 2026:

- Unit tests: **10 passed, 0 failed**
- Production build: **passed**
- Lint command: **not configured**
- Type-check command: **not configured**
- E2E command/framework: **not configured**
- Edge Function automated tests: **not present**

Existing unit coverage includes duration/overnight shifts, overlap detection, one payroll example, Buddhist date parsing, payroll-cycle dates, Rich Menu query navigation and backup/CSV behavior.

## 3. Dependency Map

```text
Phase 1: canonical OT/payroll rules and data representation
  -> Phase 2: calendar/bulk/day-off behavior uses Phase 1 models
  -> Phase 3: historical summaries use Phase 1 calculations and Phase 2 day states
  -> Phase 4: bot responses consume Phase 1–3 services/data
  -> Phase 5: scheduling must preserve Phase 4 bot and existing shift reminders
  -> Phase 6: expiration notifications reuse Phase 3 month policy and Phase 5 infrastructure
  -> Phase 7: performance and regression validation across all prior phases
```

External dependencies:

- LINE LIFF application and LINE Login channel
- LINE Official Account / Messaging API channel
- Supabase PostgreSQL, Edge Functions, Vault, pg_cron and pg_net
- Vercel frontend hosting
- A scheduler provider only if Phase 5 evaluation shows it is necessary and the user approves it

## 4. Risk Register

| Risk | Severity | Evidence / impact | Planned mitigation |
|---|---|---|---|
| Configurable `standardHours` conflicts with strict 176-hour requirement | High | Current UI/schema allow changes | Resolve explicitly during Phase 1 audit before code changes |
| Special OT is coupled to a shift | High | Cannot record independent OT | Design a separate record or compatible model in Phase 1; migrate non-destructively |
| Overlapping shifts may double-count hours | High | Warning allows saving and payroll sums both | Define confirmed conflict/counting rule and add tests before implementation |
| Full-state replacement deletes records omitted by the client | High | `replace_user_state` reconciles by delete/insert | Preserve optimistic concurrency; consider scoped APIs for bulk/history work |
| Frontend stack differs from Master Prompt | Medium | Vanilla JS rather than React/TS | Do not perform an unrequested rewrite; document any migration as a separate decision |
| No Day Off data model | High | Phase 2 and later bot/history features depend on it | Add a minimally invasive representation after schema audit |
| All history is loaded at bootstrap | Medium | Performance and payload growth risk | Introduce month-scoped queries/cache in Phase 3 |
| Production Cron/CPU state is not represented fully in Git | High | Phase 5 choice could be based on wrong assumptions | Read-only dashboard audit and before/after metrics before selecting architecture |
| Custom auth on functions with `verify_jwt=false` | High | A missed check exposes privileged service-role paths | Maintain explicit LINE/Cron verification and add negative security tests |
| RLS has no direct-user policies | Medium | Safe only while browser never accesses tables directly | Preserve server-only boundary or design explicit policies before any direct access |
| Rich Menu page 1 has no confirmed free switch area | Medium | Requirement forbids replacing existing actions | Audit LINE console and propose chat-command/alias alternatives before mutation |
| LINE IDs can differ across providers | High | Push recipient mapping may fail | Verify LINE Login and Messaging API channels share a Provider |
| No E2E harness | High | Mobile LIFF regressions are currently manual | Add Playwright-based local E2E and a connected-environment checklist before release |
| Large PDF dependencies | Medium | Largest build chunks are jsPDF/html2canvas | Keep lazy loading; measure in Phase 7 |
| `prompt.md` is ignored by Git | Medium | Requirements may not be versioned | Do not change ignore rules without approval; keep this plan traceable in `docs/` |

## 5. Master Plan

Implementation proceeds one phase at a time. Completed work remains undeployed until separate production approval.

### Phase 1 — Shift & OT Business Logic

Status: **Committed and pushed (`d5ccc3d`) — Not deployed**

Objective: establish one tested source of truth for regular hours, Normal OT, Special OT, premiums and payroll without changing confirmed business rules.

Planned tasks:

1. Re-audit every payroll consumer and confirm the 176-hour/configurable-hours decision with the user.
2. Define Special OT as an independent item with date, integer hours and optional note.
3. Define migration/compatibility for existing `urgent_ot_hours` values without double counting.
4. Define how overlapping shifts affect worked hours; do not infer a payroll rule.
5. Centralize calculation contracts used by LIFF and future bot responses.
6. Add boundary tests for 120/176/184 regular hours plus 8 Special OT hours.
7. Add tests proving evening/night premiums remain unchanged.
8. Add API validation, authorization and migration tests if the data model changes.

Implementation result (15 October 2026):

- Confirmed `standardHours` remains user-configurable with a default of 176.
- Added independent `specialOtItems` with date, integer hours and optional note.
- Added create, edit and delete UI for Special OT without requiring a shift type or time range.
- Changed worked-hour aggregation to merge parallel time ranges before flooring to full hours.
- Kept shift premiums calculated per saved shift record.
- Added a non-destructive `special_ot_items` migration and migrated legacy `urgent_ot_hours` using the original shift ID.
- Kept old-client compatibility during rollout and prevented Special OT from being deleted when its origin shift is removed.
- Updated CSV and JSON backup/restore; legacy backup files migrate embedded urgent OT automatically.
- Added backend validation, per-user persistence, RLS enablement and revoked direct browser roles.
- Added Playwright mobile E2E coverage for overlapping shifts, configurable standard hours and Special OT CRUD.

Verification result:

- Unit tests: 13 passed, 0 failed.
- Mobile Chrome E2E: 1 passed, 0 failed.
- Vite production build: passed.
- Supabase migration dry-run: passed; only `202610150003_special_ot_items.sql` is pending.
- Migration and Edge Function have not been deployed.

Likely affected files after approval:

- `src/calculations.js`
- `src/app.js`
- `src/seed.js`
- `index.html`
- `supabase/functions/app-api/index.ts`
- New non-destructive Supabase migration
- `tests/calculations.test.mjs` and additional tests

Acceptance criteria:

- Normal OT follows the confirmed 176-hour rule.
- Special OT is independent, immediate and counted once.
- Existing premiums are unchanged.
- Legacy data remains readable and migrates safely.
- Unit, API validation and regression tests pass.

Gate: completed locally and stopped before Phase 2. Database migration, Edge Function and frontend remain undeployed.

### Phase 2 — Calendar UX/UI + Bulk Shift + Day Off

Status: **Committed and pushed (`83412ce`) — Not deployed**

Dependencies: Phase 1 calculation and Special OT contracts.

Planned tasks:

1. Define Day Off representation after inspecting the Phase 1 schema outcome.
2. Change date tapping to selection/details only; retain the bottom add action.
3. Implement multi-date selection for morning, evening, night and Day Off.
4. Preserve selections while switching categories.
5. Add preview, conflict detection and explicit confirmation before replacing an existing shift with Day Off.
6. Use a safe batch operation with clear partial-failure behavior and double-submit protection.
7. Add local loading, success and error states.
8. Apply required accessible colors, labels, legend and mobile safe-area behavior.
9. Add responsive E2E coverage at representative iPhone viewport sizes.

Implementation result (15 October 2026):

- Added a dedicated per-user `day_offs` model with one Day Off per date, RLS enabled and direct browser-role access revoked.
- Kept Day Off outside payroll shifts, so it contributes zero regular hours, Normal OT, premium and salary deduction.
- Added a four-category bulk flow for configured shift types plus Day Off with multi-date selection and retained selections while switching categories.
- Added a live preview, duplicate skipping, overlap warnings, explicit shift/Day Off replacement confirmation and double-submit protection.
- Changed calendar date taps to select and show details only; adding now starts from the bottom action.
- Added required calendar colors, Day Off indicators, expanded text labels, mobile safe-area behavior and accessible state labels.
- Made batch persistence one full-state transaction; the UI renders saved data only after backend confirmation and restores state on failure.
- Preserved Special OT when replacing shifts with Day Off and added cancel/delete Day Off behavior.
- Updated CSV and backup/restore compatibility and migrated legacy local state safely.

Verification result:

- Unit tests: 17 passed, 0 failed.
- Mobile Chrome E2E: 2 passed, 0 failed, including Phase 1 regression.
- Vite production build: passed.
- Supabase migration dry-run: passed; migrations 003 and 004 are pending and were not applied.
- Database, Edge Functions, frontend and production configuration have not been deployed.

Likely affected files after approval:

- `index.html`
- `src/app.js`
- `src/styles.css`
- `src/calculations.js`
- `src/service.js`
- `supabase/functions/app-api/index.ts`
- New migration if Day Off needs schema support
- Unit and E2E tests

E2E scenarios:

- Onboarding and mobile navigation
- Select/unselect multiple dates
- Switch shift categories without losing selections
- Save mixed shifts and Day Off in one batch
- Conflict confirmation and cancellation
- Day Off contributes zero hours, OT and premium
- Calendar details do not open the add form automatically
- No horizontal input overflow on small screens

Acceptance criteria:

- Bulk shifts and Day Off save correctly without duplicates.
- Day Off never creates hours, Normal OT or premiums and never removes Special OT automatically.
- Calendar behavior and responsive UI match the prompt.
- Unit, integration and E2E tests pass.

Gate: stop and report before Phase 3.

### Phase 3 — Historical Data (Current Month + Previous 2 Months)

Status: **Completed locally — Not deployed**

Dependencies: Phase 1 calculations and Phase 2 Day Off model.

Planned tasks:

1. Add an Asia/Bangkok calendar-month range utility.
2. Add a selector limited to current month and previous two calendar months.
3. Add month-scoped backend reads for shifts, Day Off, Special OT and financial summaries.
4. Keep payroll-cycle calculations separate from historical calendar-month summaries.
5. Cache by user/month and invalidate affected months after mutations.
6. Handle year boundaries, leap years, overnight shifts and empty months.
7. Confirm that leaving the display range never deletes database records.

Implementation result (15 October 2026):

- Added a dedicated Historical Data screen so the operational calendar can continue showing future shifts.
- Added an Asia/Bangkok month selector limited to the current month and previous two calendar months, including year boundaries.
- Added calendar-month summaries for shifts, Day Off, Special OT, worked hours, Normal OT, premiums, additional income, deductions and estimated net income.
- Added month-scoped authenticated Supabase queries filtered by `user_id` and `work_date`.
- Added a per-authenticated-service month cache and invalidated it after every successful state mutation.
- Added loading, error, retry and empty states for mobile LIFF usage.
- Kept records outside the three-month display window untouched; no deletion or retention logic was added.
- Added backward-compatible fallback to the already-loaded state while an older Edge Function does not yet support `month-history`.

Verification result:

- Unit tests: 22 passed, 0 failed.
- Mobile Chrome E2E: 3 passed, 0 failed, including Phase 1–2 regression.
- Vite production build: passed.
- No database migration was required for Phase 3.
- Edge Function and frontend changes have not been manually deployed.

Likely affected files after approval:

- `src/date.js`
- `src/calculations.js`
- `src/app.js`
- `src/service.js`
- `index.html`, `src/styles.css`
- `supabase/functions/app-api/index.ts`
- Index migration only if query evidence requires it
- Unit, API and E2E tests

E2E scenarios:

- October exposes August–October only.
- January crosses the year boundary correctly.
- Selected-month calendar and income agree.
- Empty state and cache refresh after add/edit/delete work correctly.

Acceptance criteria:

- Exactly three allowed calendar months are selectable.
- Historical shifts, Day Off, OT and income use actual month-scoped data.
- No old data is deleted.
- Unit, integration and E2E tests pass.

Gate: stop and report before Phase 4.

### Phase 4 — LINE Rich Menu Page 2 + LINE Bot

Status: **Completed locally — Not deployed**

Dependencies: Phase 1 payroll service, Phase 2 Day Off and Phase 3 month queries.

Planned tasks:

1. Audit actual LINE Rich Menu IDs, areas, aliases, default menu, Provider and webhook state read-only.
2. Select a navigation approach without modifying page 1 actions unless approved.
3. Create one page-2 asset/configuration with the six required actions.
4. Add a webhook Edge Function with raw-body signature verification and duplicate-event protection.
5. Add authorized postbacks for next shift, monthly income, OT, Day Off, monthly shifts and help.
6. Reuse canonical payroll/history services rather than recreating formulas.
7. Add private-chat protection for salary information and Flex Message validation.
8. Test aliases/navigation in a non-production or controlled setup before requesting production approval.

Implementation result (15 October 2026):

- Preserved the existing page-1 image, four actions and default-menu configuration without modification.
- Selected the non-destructive `เมนูเพิ่มเติม` chat command as the page-2 entry point because page 1 has no unused action area.
- Added a pastel-pink 2500×1686 page-2 SVG and upload-ready PNG under 1 MB, with six postbacks and a `richmenuswitch` return action.
- Added a dedicated LINE webhook Edge Function that verifies `x-line-signature` against the raw request body before parsing JSON.
- Added LINE-user-to-profile authorization, per-user queries, private-chat protection for monthly income and generic unlinked-account handling.
- Added six Flex Message responses using real Supabase data for next shift, current-month income, OT, Day Off, shift counts and help.
- Reused the confirmed monthly payroll rules in a tested shared bot module: configurable standard hours defaulting to 176, overlap de-duplication and immediate Special OT.
- Added an additive webhook-event table and atomic claim function for duplicate-event protection and bounded stale/failed retry.
- Added setup, alias, controlled verification and rollback instructions without changing LINE or Supabase production configuration.

Verification result:

- Unit/security/contract tests: 28 passed, 0 failed, including signature verification, privacy, formula parity, Flex structure and page-1 preservation.
- Mobile Chrome E2E regression: 3 passed, 0 failed.
- Vite production build: passed.
- Supabase migration dry-run: passed; migrations 003, 004 and 005 remain pending and were not applied.
- Deno CLI is not installed locally, so live Edge Function boot/type validation remains part of controlled deployment verification.
- Rich Menu, aliases, webhook URL, secrets, migration and Edge Function were not deployed or changed in Production.

Likely affected files after approval:

- New Rich Menu page-2 asset/configuration in `assets/` and `docs/`
- New or extended Supabase Edge Function for webhook handling
- Shared backend calculation/query modules if introduced
- New migration only for webhook idempotency if required
- Contract/security tests and LINE manual verification checklist

Acceptance criteria:

- Page 1 remains unchanged and functional.
- Page 2 and navigation work using the approved approach.
- All six postbacks return authorized real data.
- Signature, privacy and duplicate-processing tests pass.

Gate: do not upload/switch production Rich Menus; stop and report before Phase 5.

### Phase 5 — Notification Scheduling V2

Status: **Implemented locally in Shadow Mode — Not deployed**

Dependencies: existing reminders and Phase 4 LINE behavior.

Task 5.1 audit plan:

1. Inventory notification code, tables, functions, secrets and real scheduler configuration.
2. Inspect production pg_cron/Vercel Cron read-only and capture frequency.
3. Capture Supabase CPU/query metrics and query plans where access permits.
4. Map current creation, claim, delivery, retry and recovery paths.
5. Evaluate external scheduler, database queue and low-frequency recovery alternatives.
6. Document costs, free-tier limits, reliability, operational dependencies and failure modes.
7. Propose non-destructive migrations, feature flags, shadow mode, rollback and cutover.
8. Stop and obtain approval before Task 5.2.

Task 5.1 audit result (15 October 2026):

- Confirmed the repository's legacy flow: five-minute pg_cron example → pg_net → authenticated `send-reminders` → computed candidate view → atomic claim → LINE push → delivery log.
- Confirmed no Vercel Cron configuration and no independent one-time/daily/weekly/monthly job model.
- Documented existing protections and correctness gaps, including early-send window, missed-job window, non-classified retries, LINE 409 handling and missing cancellation generations.
- Captured a read-only remote baseline: 2 profiles, 25 shifts, 4 reminders, 0 notification logs, 12 MB database and 100% cache hit rates.
- Found an unrelated/unattributed high-risk metric anomaly: about 30.5M request setup calls and 29.7M `user_settings` sequential scans in roughly 11.5 hours. This cannot be attributed to a five-minute cron without further logs.
- Selected an indexed Postgres job queue with a Supabase Cron worker as the proposed default; retained an external scheduler adapter boundary without adding a paid provider.
- Compared Supabase Cron, per-job pg_cron, Upstash QStash and Vercel Cron with current documented limits and costs.
- Defined additive schema, Shadow Mode, controlled cutover, retry semantics, recovery and rollback in `docs/PHASE5_NOTIFICATION_AUDIT.md`.
- No application code, schema, cron, Edge Function or production configuration was changed.

Implementation outline after separate approval:

- Reuse equivalent tables where possible; otherwise add rules/jobs/deliveries with UUIDs, `timestamptz`, timezone, idempotency, leases and indexes.
- Add scheduler adapter, signed callbacks, cancellation/rescheduling and stale-callback rejection.
- Process a specific job with atomic claim, recipient authorization and stable LINE retry semantics.
- Add indexed low-frequency recovery without full-table polling.
- Preserve legacy reminders until shadow verification succeeds.

Implementation result (15 October 2026):

- Added an additive V2 schema for notification rules, jobs, delivery attempts and per-user delivery modes with RLS and service-role-only access.
- Added one-time, daily, weekly, monthly and shift-offset scheduling with timezone-aware calculation and Bangkok default.
- Added event-driven shift/reminder materialization after state mutations; jobs default to Shadow Mode.
- Added atomic indexed claims, five-minute leases, stable idempotency/retry keys, cancellation generations, bounded transient retry and dead-job state.
- Added signed external callback verification, a database/external scheduler adapter boundary and low-frequency indexed recovery.
- Updated `send-reminders` while keeping `{}` as the legacy default and requiring an explicit mode for V2 delivery.
- Added per-user controlled cutover that excludes only V2 users from the legacy candidate view and preserves compatibility logs for rollback.
- Added deployment/rollback documentation and V2 cron examples without changing Production configuration.
- Unit/contract tests pass; browser E2E was intentionally not run per the latest user instruction.

Testing plan:

- All 20 cases in Prompt 4 Task 5.8
- Security tests for unauthorized callbacks and recipient isolation
- Concurrency/idempotency tests
- Before/after query and CPU measurements
- E2E setting flows for create, edit, disable and cancel

Acceptance criteria:

- No duplicate LINE delivery under tested retry/concurrency conditions.
- Cancellation/rescheduling and recovery work.
- Query overhead is measurably reduced or the result is documented honestly.
- Legacy reminders remain recoverable and rollback is documented.

Gate: no paid provider, Cron change, real-delivery cutover or production deployment without explicit approval; stop before Phase 6.

### Phase 6 — Automatic Data Expiration LINE Notifications

Status: **Implemented locally — Deletion disabled — Not deployed**

Dependencies: Phase 3 calendar-month policy and Phase 5 scheduling infrastructure.

Planned tasks:

1. Calculate the month leaving the three-month display window in Asia/Bangkok.
2. Schedule 7-day, 3-day and 1-day notifications only for users with relevant data and consent.
3. Generate Thai messages without salary details or claims that data will definitely be deleted.
4. Reuse Phase 5 jobs, deliveries, idempotency and recovery.
5. Add a separate notification preference without breaking shift reminders.
6. Implement retention dry-run reporting only: eligible month and record counts.
7. Document legal/retention questions and backup/restore requirements.
8. Keep automatic deletion disabled.

Testing plan:

- October/November rollover, year rollover and February
- 7/3/1-day schedules
- opt-out, no matching data and missing LINE ID
- retry/idempotency and legacy reminder compatibility
- prove no DELETE is executed

Acceptance criteria:

- Notifications are sent on the correct dates once only.
- Phase 5 infrastructure is reused.
- Opt-out is respected.
- No records are automatically deleted.

Implementation result (15 October 2026):

- Added a separate expiration-notification preference without changing existing shift-reminder settings.
- Reused Phase 5 rules, jobs, delivery attempts, idempotency, retry and recovery; no additional cron is required.
- Added dynamic Bangkok calendar-month planning for 7, 3 and 1 days before the oldest visible month leaves the three-month window.
- Added Thai LINE templates without salary details or claims of deletion.
- Added indexed dry-run records with counts for shifts, Special OT, Day Off and financial items.
- Enforced `deletion_enabled = false` at Database level and added no business-data DELETE path.
- Added unit/contract coverage for month rollover, year rollover, February, preferences, no-data behavior and no-delete constraints.

Gate: no retention-policy change or production scheduler activation without approval; stop before Phase 7.

### Phase 7 — Performance Optimization + Regression Testing

Status: **Completed locally — Production verification pending — Not deployed**

Dependencies: all prior authorized phases.

Planned tasks:

1. Establish frontend load, interaction, network, bundle and backend query baselines.
2. Confirm LIFF initializes once and eliminate proven duplicate requests.
3. Measure month queries, notification claims and relevant indexes with query plans.
4. Apply caching, lazy loading, skeletons and index changes only when measurements justify them.
5. Add/complete an E2E suite covering onboarding, profile/settings, shift/OT, bulk/day-off, history, exports and notification preferences.
6. Run security regression for LINE authentication, callback authorization, RLS boundary and secret isolation.
7. Run payroll regression for 176-hour Normal OT, Special OT and existing premiums.
8. Produce before/after measurements and a production-readiness report.

E2E execution layers:

- Local deterministic E2E using mock/local mode for UI and business workflows
- Backend contract/integration tests using an isolated Supabase environment
- Controlled LINE LIFF smoke tests for login, friendship, webhook and push behavior
- Production smoke tests only after explicit deployment authorization

Acceptance criteria:

- Build and all configured checks pass.
- E2E tests pass for critical workflows.
- Authentication, authorization, RLS boundaries, payroll, calendar, history, bot and notifications have no detected regression.
- Performance results are measured and documented rather than assumed.

Implementation result (15 October 2026):

- Removed seven redundant state-table reads after each successful save; the API now returns only the authoritative version.
- Added backward-compatible client handling for both old full-state and new version-only responses.
- Changed mutation rendering from all hidden screens to the active screen only and retained render-on-navigation correctness.
- Reused a single LIFF initialization promise and confirmed the Supabase client remains module-scoped.
- Kept PDF dependencies lazy-loaded and added immutable caching for hashed Vercel assets.
- Disabled Production source maps, removing approximately 2.70 MB of generated map artifacts per build.
- Added notification operational indexes justified by controlled cutover and delivery-history queries.
- Added Unit/Contract regression checks; browser E2E remains disabled by explicit user instruction.
- Documented honest before/after measurements, security status, remaining risks and Production verification gates.

Gate: produce the final readiness report; deployment remains a separate user-approved action.

## 6. Phase Status Dashboard

| Phase | Status | Blocking dependency | Evidence required to complete |
|---|---|---|---|
| 1. Shift & OT Business Logic | Committed and pushed; not deployed | Deployment approval remains separate | 13 unit tests, 1 mobile E2E, build and migration dry-run passed |
| 2. Calendar + Bulk + Day Off | Committed and pushed; not deployed | Deployment approval remains separate | 17 unit tests, 2 mobile E2E, build and migration dry-run passed |
| 3. Historical Data | Completed locally; not deployed | Deployment approval remains separate | 22 unit tests, 3 mobile E2E and build passed |
| 4. Rich Menu Page 2 + Bot | Completed locally; not deployed | Controlled LINE verification and deployment approval | 28 unit/security tests, 3 mobile E2E, build and migration dry-run passed |
| 5. Notification Scheduling V2 | Implemented locally in Shadow Mode; not deployed | Controlled DB/LINE verification and production approval | Unit/contract verification, dry-run, metrics and rollback |
| 6. Expiration Notifications | Implemented locally; deletion disabled; not deployed | Controlled Phase 5 Shadow verification | Unit/contract verification, dry-run evidence and no-delete proof |
| 7. Performance + Regression | Completed locally; Production verification pending; not deployed | Deployment and controlled smoke-test approval | Measurements, Unit/Contract regression and readiness report |

## 7. Known Issues and Open Decisions

Resolved in Phase 1:

- `standardHours` is user-configurable and defaults to 176.
- Parallel shift time ranges count once toward worked hours.
- Special OT is an independent record; legacy urgent OT is migrated non-destructively.

Remaining decisions:

1. Controlled LINE verification requires the existing page-1 Rich Menu ID and a newly created page-2 Rich Menu ID; no Production mutation was made.
2. Run Phase 5 Shadow Mode measurements and controlled LINE verification before enabling V2 delivery.
3. Determine the isolated environment and test identities available for connected backend and LINE smoke tests; browser E2E remains disabled by user instruction.
4. `README.md` references `.env.example`, but no tracked `.env.example` was found in the audit inventory.

## 8. Next Step

All seven local implementation phases are complete. Production deployment, migrations, Cron activation and controlled LINE verification remain separate approval-gated work.

No deployment is included in any implementation step unless the user separately authorizes it.
