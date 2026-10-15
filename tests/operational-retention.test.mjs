import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/202610150009_operational_data_retention.sql', import.meta.url), 'utf8');

test('operational retention never deletes user-owned roster or payroll tables', () => {
  for (const table of ['profiles', 'user_settings', 'shift_types', 'shifts', 'special_ot_items', 'day_offs', 'financial_items', 'reminders']) {
    assert.doesNotMatch(migration, new RegExp(`delete\\s+from\\s+public\\.${table}\\b`, 'i'));
  }
  assert.match(migration, /'userDataDeleted', false/);
});

test('operational retention preserves active notification work', () => {
  assert.match(migration, /status in \('sent', 'cancelled', 'dead'\)/);
  assert.match(migration, /status = 'shadow'/);
  assert.doesNotMatch(migration, /status in \([^)]*'pending'/);
  assert.doesNotMatch(migration, /status in \([^)]*'retry'/);
  assert.doesNotMatch(migration, /status in \([^)]*'leased'/);
});

test('cleanup is scheduled once daily only when pg_cron already exists', () => {
  assert.match(migration, /extname = 'pg_cron'/);
  assert.match(migration, /nurseshift-operational-retention/);
  assert.match(migration, /'17 20 \* \* \*'/);
});
