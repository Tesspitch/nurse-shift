import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackup, createCsv, reminderLabel, restoreBackup } from '../src/data-transfer.js';
import { createInitialState } from '../src/seed.js';
import { calculatePayroll } from '../src/calculations.js';

test('formats configurable reminder lead times', () => {
  assert.equal(reminderLabel(30), 'ก่อน 30 นาที');
  assert.equal(reminderLabel(120), 'ก่อน 2 ชั่วโมง');
  assert.equal(reminderLabel(2880), 'ก่อน 2 วัน');
});

test('restores a backup without replacing the signed-in profile or state version', () => {
  const current = createInitialState();
  current.version = 7;
  current.profile = { displayName: 'Current user', pictureUrl: 'current.png' };
  const source = createInitialState();
  source.settings.salary = 25000;
  source.specialOtItems.push({ id: crypto.randomUUID(), workDate: '2026-10-02', hours: 2, note: 'เคสด่วน' });
  source.dayOffs.push({ id: crypto.randomUUID(), workDate: '2026-10-04' });
  const restored = restoreBackup(current, createBackup(source));
  assert.equal(restored.settings.salary, 25000);
  assert.equal(restored.version, 7);
  assert.deepEqual(restored.profile, current.profile);
  assert.equal(restored.specialOtItems[0].hours, 2);
  assert.equal(restored.dayOffs[0].workDate, '2026-10-04');
});

test('migrates legacy shift OT into independent special OT during restore', () => {
  const current = createInitialState();
  const legacy = createBackup(createInitialState());
  legacy.formatVersion = 1;
  delete legacy.data.specialOtItems;
  legacy.data.shifts.push({
    id: crypto.randomUUID(), shiftTypeId: 'morning', workDate: '2026-10-03',
    startTime: '08:00', endTime: '16:00', urgentOtHours: 3, note: 'legacy'
  });
  const restored = restoreBackup(current, legacy);
  assert.equal(restored.specialOtItems.length, 1);
  assert.equal(restored.specialOtItems[0].hours, 3);
  assert.equal(restored.shifts[0].urgentOtHours, 0);
});

test('creates a UTF-8 compatible CSV body and escapes commas', () => {
  const state = createInitialState();
  state.settings.salary = 20000;
  state.financialItems.push({ id: crypto.randomUUID(), kind: 'deduction', label: 'ภาษี,ประกัน', amount: 500, workDate: '2026-10-01' });
  const csv = createCsv(state, calculatePayroll(state, new Date(2026, 9, 15)));
  assert.match(csv, /"ภาษี,ประกัน"/);
  assert.match(csv, /ยอดสุทธิโดยประมาณ/);
});
