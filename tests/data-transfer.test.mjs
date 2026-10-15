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
  const restored = restoreBackup(current, createBackup(source));
  assert.equal(restored.settings.salary, 25000);
  assert.equal(restored.version, 7);
  assert.deepEqual(restored.profile, current.profile);
});

test('creates a UTF-8 compatible CSV body and escapes commas', () => {
  const state = createInitialState();
  state.settings.salary = 20000;
  state.financialItems.push({ id: crypto.randomUUID(), kind: 'deduction', label: 'ภาษี,ประกัน', amount: 500, workDate: '2026-10-01' });
  const csv = createCsv(state, calculatePayroll(state, new Date(2026, 9, 15)));
  assert.match(csv, /"ภาษี,ประกัน"/);
  assert.match(csv, /ยอดสุทธิโดยประมาณ/);
});
