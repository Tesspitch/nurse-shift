import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState } from '../src/service.js';
import { createInitialState } from '../src/seed.js';

test('normalizes a remote state created before Special OT and Day Off existed', () => {
  const legacy = createInitialState();
  delete legacy.specialOtItems;
  delete legacy.dayOffs;
  legacy.shifts.push({
    id: crypto.randomUUID(),
    shiftTypeId: 'morning',
    workDate: '2026-10-01',
    startTime: '08:00',
    endTime: '16:00',
    urgentOtHours: 2,
    note: 'legacy'
  });

  const normalized = normalizeState(legacy);
  assert.equal(normalized.specialOtItems.length, 1);
  assert.equal(normalized.specialOtItems[0].hours, 2);
  assert.deepEqual(normalized.dayOffs, []);
  assert.equal(normalized.shifts[0].urgentOtHours, 0);
});

test('normalizes null collections returned during a staged backend rollout', () => {
  const partial = createInitialState();
  partial.specialOtItems = null;
  partial.dayOffs = null;
  partial.financialItems = null;
  partial.reminders = null;
  const normalized = normalizeState(partial);
  assert.deepEqual(normalized.specialOtItems, []);
  assert.deepEqual(normalized.dayOffs, []);
  assert.deepEqual(normalized.financialItems, []);
  assert.deepEqual(normalized.reminders, []);
});
