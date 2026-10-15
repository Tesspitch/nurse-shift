import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/202610150006_notification_scheduling_v2.sql', import.meta.url), 'utf8');
const worker = await readFile(new URL('../supabase/functions/send-reminders/index.ts', import.meta.url), 'utf8');

test('V2 schema is additive, protected by RLS and preserves legacy notification records', () => {
  for (const table of ['notification_delivery_modes', 'notification_rules', 'notification_jobs', 'notification_deliveries']) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.doesNotMatch(migration, /drop\s+(table|column)|truncate\s+|delete\s+from\s+public\.notification_logs/i);
});

test('due and recovery paths use partial indexes and atomic skip-locked claims', () => {
  assert.match(migration, /notification_jobs_due_idx[\s\S]+where status in \('pending', 'retry'\)/);
  assert.match(migration, /notification_jobs_expired_lease_idx[\s\S]+where status = 'leased'/);
  assert.match(migration, /for update of job skip locked/i);
  assert.match(migration, /leased_until = now\(\) \+ interval '5 minutes'/i);
});

test('rescheduling and cancellation invalidate generations and pending work', () => {
  assert.match(migration, /generation = public\.notification_rules\.generation \+ 1/);
  assert.match(migration, /create or replace function public\.cancel_notification_rule_v2/);
  assert.match(migration, /status = 'cancelled'/);
  assert.match(migration, /rule\.generation = job\.generation/);
});

test('worker keeps legacy default while V2 batch, job and recovery modes are explicit', () => {
  assert.match(worker, /body\.mode === 'v2-batch'/);
  assert.match(worker, /body\.mode === 'v2-job'/);
  assert.match(worker, /body\.mode === 'v2-recovery'/);
  assert.match(worker, /: await runLegacy\(\)/);
});

test('worker requires scheduler authorization and never logs recipients or salary payloads', () => {
  assert.match(worker, /x-cron-secret/);
  assert.match(worker, /verifySchedulerInvocation/);
  assert.doesNotMatch(worker, /console\.(?:log|error)\([^\n]*(?:line_user_id|salary)/i);
});
