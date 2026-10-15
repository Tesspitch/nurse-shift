import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/202610150007_data_expiration_notifications.sql', import.meta.url), 'utf8');
const worker = await readFile(new URL('../supabase/functions/send-reminders/index.ts', import.meta.url), 'utf8');

test('expiration preference reuses user settings and Phase 5 jobs', () => {
  assert.match(migration, /alter table public\.user_settings[\s\S]+expiration_notifications_enabled/);
  assert.match(migration, /insert into public\.notification_jobs/);
  assert.match(migration, /notification_type = 'data_expiration'/);
  assert.doesNotMatch(migration, /create table if not exists public\.expiration_notification_jobs/);
});

test('planner uses the 7, 3 and 1 day schedule in Bangkok time', () => {
  assert.match(migration, /array\[7, 3, 1\]/);
  assert.match(migration, /time '09:00'\) at time zone 'Asia\/Bangkok'/);
  assert.match(migration, /interval '2 months'/);
});

test('retention dry run structurally forbids automatic deletion', () => {
  assert.match(migration, /deletion_enabled boolean not null default false check \(deletion_enabled = false\)/);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.(?:shifts|special_ot_items|day_offs|financial_items|profiles)/i);
  assert.doesNotMatch(migration, /truncate|drop\s+table/i);
});

test('disabled preferences cancel pending expiration jobs', () => {
  assert.match(migration, /sync_data_expiration_preference_v2/);
  assert.match(migration, /EXPIRATION_NOTIFICATION_DISABLED/);
  assert.match(migration, /status in \('shadow', 'pending', 'retry', 'leased'\)/);
});

test('users without expiring data or LINE eligibility do not receive jobs', () => {
  assert.match(migration, /shift_count \+ v_user\.special_ot_count \+ v_user\.day_off_count \+ v_user\.financial_item_count = 0 then continue/);
  assert.match(migration, /length\(v_user\.line_user_id\) > 0/);
  assert.match(migration, /notifications_enabled and v_user\.expiration_notifications_enabled/);
});

test('recovery worker materializes expiration jobs without a separate scheduler', () => {
  assert.match(worker, /materialize_data_expiration_jobs_v2/);
  assert.match(worker, /if \(recovery\)/);
  assert.match(worker, /createExpirationMessage/);
});
