import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/202610160001_scheduler_load_and_conflict_fix.sql', import.meta.url), 'utf8');

test('state conflicts use a non-retryable business error while preserving the API message', () => {
  assert.match(migration, /errcode = 'P0001', message = 'STATE_VERSION_CONFLICT'/);
  assert.doesNotMatch(migration, /errcode = '40001'/);
});

test('production scheduler removes one-minute V2 polling and keeps one five-minute worker', () => {
  assert.match(migration, /send-nurse-shift-reminders-v2/);
  assert.match(migration, /recover-nurse-shift-reminders-v2/);
  assert.match(migration, /cron\.unschedule/);
  assert.match(migration, /'send-nurse-shift-reminders',[\s\S]*'\*\/5 \* \* \* \*'/);
  assert.doesNotMatch(migration, /'\* \* \* \* \*'/);
});

test('scheduler credentials stay in Vault and are never committed as literals', () => {
  assert.match(migration, /vault\.decrypted_secrets/);
  assert.match(migration, /name = 'reminder_cron_secret'/);
  assert.doesNotMatch(migration, /Bearer\s+[A-Za-z0-9_-]{20,}/);
});
