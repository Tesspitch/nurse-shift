# Phase 7 — Performance Optimization and Regression Report

วันที่: 15 ตุลาคม 2026  
สถานะ: Production deployed; Supabase request-path optimization prepared locally

## Measured Changes

| Area | Before | After | Result |
|---|---:|---:|---|
| Follow-up reads after every state save | 7 table queries through `getState` | 0; RPC returns the new state version | Removes redundant state reload while preserving optimistic concurrency |
| Render work after mutation | Home, Calendar, Finance, Settings, printable slip and history selector | Active screen only | Hidden screens render when opened instead of on every save |
| LIFF initialization within module lifecycle | New initialization whenever service factory is called | One shared initialization promise | Prevents duplicate LIFF setup/profile/friendship requests |
| Production source maps emitted | approximately 2.70 MB | 0 MB | Lower build/deploy storage and processing; no runtime debugging map exposure |
| Main app gzip after Phase 6 vs Phase 7 | 16.02 kB | 16.06 kB | +0.04 kB from active-render/version compatibility logic; no false bundle-size improvement claimed |
| Initial HTML + CSS + app JS gzip | approximately 29.30 kB | approximately 29.34 kB | Essentially unchanged; PDF libraries remain lazy-loaded |
| Existing-user database calls per state save | 5 | 1 warm / 2 cold | Removes repeated default-data upserts and suppresses simultaneous duplicate saves |
| Existing-user database calls per bootstrap | 11 | 7 warm / 8 cold | Keeps required table reads while caching profile resolution |

Build time changed from 501 ms in the preceding local run to 319 ms after source maps were disabled. This is a single-machine observation, not a reliable performance benchmark.

## Frontend

- PDF libraries remain dynamic imports and are excluded from initial execution.
- Hashed `/assets/*` files now receive immutable one-year browser caching.
- The app renders only the active screen after a mutation; navigation renders the destination before display.
- History retains month cache and request-id stale-response protection.
- Concurrent bootstrap and same-month history reads share one in-flight request.
- A second state mutation cannot start while the first save is still pending.
- LIFF initialization is shared for the module lifecycle.
- Full-page reload remains only after confirmed account deletion outside the LINE client.

## Backend and Database

- `replace-state` now returns only the authoritative new version; the client retains its validated state and updates that version.
- Conflict recovery still performs a full bootstrap when the Database reports `STATE_VERSION_CONFLICT`.
- Existing profiles no longer upsert settings, shift types and reminder defaults on every action; those writes run only during first-time initialization.
- Profile lookup is cached for five minutes per warm Edge Function isolate and profile metadata is updated only when LINE name or picture changes.
- Existing read queries execute in parallel and all user/date filters have supporting indexes.
- Added partial operational indexes for active notification jobs and job delivery history.
- Phase 5 due-job and recovery paths remain indexed and avoid full candidate joins for V2 users.

## Regression Coverage

Configured Unit/Contract tests cover:

- Normal OT with configurable 176-hour default
- Special OT independence and no overlap double counting
- Existing shift premiums
- Bulk shifts and Day Off behavior
- Three-month historical calculations
- LINE signature, privacy and bot actions
- Notification scheduling, retry, cancellation and authorization
- Expiration 7/3/1-day planning and no-delete constraints
- State-save response compatibility, single LIFF initialization and active-screen rendering contracts

Browser E2E was neither added nor run, following the latest user instruction. Unit/Contract coverage verifies the new request deduplication contracts.

## Security Review

- LINE ID token verification and per-profile authorization remain unchanged.
- RLS remains enabled for private and operational tables.
- Service-role and LINE secrets remain backend-only.
- Scheduler callbacks require cron secret or signed request.
- Salary data is not written to notification operational logs.
- No automatic data deletion path exists.

## Production Readiness

Migrations 006–008, `app-api` and `send-reminders` were deployed and their authorization boundaries were verified. The request-path optimization documented here remains a local change until its commit is pushed and the updated frontend/API are deployed.

Before Production cutover:

1. Apply migrations in order in a controlled window.
2. Deploy Edge Functions and frontend while keeping notifications in legacy/shadow mode.
3. Capture Supabase CPU, request counts, Edge invocation errors and query plans.
4. Compare Phase 5 shadow jobs with legacy candidates.
5. Smoke-test LIFF authentication, state save, LINE push and rollback with a controlled profile.
6. Enable V2 per user only after explicit approval.

## Remaining Risks

- The previously observed high `user_settings` scan/request anomaly needs Production logs to attribute conclusively.
- SQL concurrency and real LINE retry behavior require an isolated/controlled connected verification.
- Browser-specific visual regression is untested because E2E is disabled.
- Performance figures from local builds do not substitute for Vercel Web Vitals or Supabase CPU measurements.

