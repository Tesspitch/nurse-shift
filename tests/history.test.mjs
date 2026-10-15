import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedHistoryMonths, calculateMonthlyHistory, monthRange } from '../src/history.js';
import { createInitialState } from '../src/seed.js';

test('allows current Bangkok month and exactly two previous calendar months', () => {
  assert.deepEqual(allowedHistoryMonths(new Date('2026-10-15T12:00:00+07:00')), ['2026-08', '2026-09', '2026-10']);
  assert.deepEqual(allowedHistoryMonths(new Date('2026-01-15T12:00:00+07:00')), ['2025-11', '2025-12', '2026-01']);
  assert.deepEqual(monthRange('2024-02'), { start: '2024-02-01', end: '2024-02-29' });
});

test('summarizes shifts, day off, OT and income for only the selected calendar month', () => {
  const state = createInitialState();
  Object.assign(state.settings, { salary: 20000, licenseAllowance: 2000, standardHours: 8, otRate: 100 });
  state.shifts = [
    { id: 'a', shiftTypeId: 'evening', workDate: '2026-09-30', startTime: '16:00', endTime: '00:00', urgentOtHours: 0, note: '' },
    { id: 'b', shiftTypeId: 'night', workDate: '2026-10-01', startTime: '00:00', endTime: '08:00', urgentOtHours: 0, note: '' },
    { id: 'c', shiftTypeId: 'morning', workDate: '2026-10-02', startTime: '08:00', endTime: '16:00', urgentOtHours: 0, note: '' }
  ];
  state.specialOtItems = [{ id: 'ot', workDate: '2026-10-02', hours: 2, note: '' }];
  state.dayOffs = [{ id: 'off', workDate: '2026-10-03' }];
  state.financialItems = [
    { id: 'income', kind: 'income', label: 'เพิ่ม', amount: 500, workDate: '2026-10-04' },
    { id: 'tax', kind: 'deduction', label: 'ภาษี', amount: 300, workDate: '2026-10-04' }
  ];

  const result = calculateMonthlyHistory(state, '2026-10');
  assert.equal(result.shifts.length, 2);
  assert.equal(result.dayOffs.length, 1);
  assert.equal(result.workedHours, 16);
  assert.equal(result.normalOtHours, 8);
  assert.equal(result.specialOtHours, 2);
  assert.equal(result.shiftIncome, 300);
  assert.equal(result.net, 23500);
  assert.equal(result.shiftCounts.night, 1);
  assert.equal(result.shiftCounts.morning, 1);
});

test('does not delete or mutate records outside the selected month', () => {
  const state = createInitialState();
  state.shifts.push({ id: 'old', shiftTypeId: 'morning', workDate: '2026-07-01', startTime: '08:00', endTime: '16:00', urgentOtHours: 0, note: '' });
  const snapshot = structuredClone(state);
  calculateMonthlyHistory(state, '2026-10');
  assert.deepEqual(state, snapshot);
});
