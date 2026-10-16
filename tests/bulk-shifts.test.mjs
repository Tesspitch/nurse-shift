import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBulkPlan, buildBulkPlan, DAY_OFF_TYPE } from '../src/bulk-shifts.js';
import { calculatePayroll } from '../src/calculations.js';
import { createInitialState } from '../src/seed.js';

function selections(entries) {
  return new Map(entries.map(([type, dates]) => [type, new Set(dates)]));
}

test('builds several shifts in one batch and skips existing duplicates', () => {
  const state = createInitialState();
  state.shifts.push({ id: crypto.randomUUID(), shiftTypeId: 'morning', workDate: '2026-10-01', startTime: '08:00', endTime: '16:00', urgentOtHours: 0, note: '' });
  const plan = buildBulkPlan(state, selections([
    ['morning', ['2026-10-01', '2026-10-02']],
    ['night', ['2026-10-03']]
  ]));
  assert.equal(plan.shifts.length, 2);
  assert.equal(plan.duplicates.length, 1);
});

test('removes marked shifts in a batch while adding newly selected shifts', () => {
  const state = createInitialState();
  state.shifts.push({
    id: 'existing-evening',
    shiftTypeId: 'evening',
    workDate: '2026-10-01',
    startTime: '23:00',
    endTime: '07:00',
    urgentOtHours: 0,
    note: ''
  });
  state.specialOtItems.push({ id: 'special-ot', workDate: '2026-10-01', hours: 2, note: 'คงรายการนี้ไว้' });
  const plan = buildBulkPlan(
    state,
    selections([['night', ['2026-10-01']]]),
    () => 'new-night',
    selections([['evening', ['2026-10-01']]])
  );

  assert.deepEqual(plan.shiftRemovals.map((shift) => shift.id), ['existing-evening']);
  assert.equal(plan.shifts.length, 1);
  assert.equal(plan.overlaps.length, 0);
  applyBulkPlan(state, plan);
  assert.deepEqual(state.shifts.map((shift) => shift.id), ['new-night']);
  assert.equal(state.specialOtItems.length, 1);
});

test('day off contributes no hours, OT, premium or salary deduction', () => {
  const state = createInitialState();
  Object.assign(state.settings, { salary: 20000, standardHours: 176, otRate: 100 });
  const plan = buildBulkPlan(state, selections([[DAY_OFF_TYPE, ['2026-10-05']]]));
  applyBulkPlan(state, plan);
  const payroll = calculatePayroll(state, new Date(2026, 9, 15));
  assert.equal(state.dayOffs.length, 1);
  assert.equal(payroll.workedHours, 0);
  assert.equal(payroll.automaticOtHours, 0);
  assert.equal(payroll.shiftPremium, 0);
  assert.equal(payroll.net, 20000);
});

test('replacing a shift with day off preserves special OT', () => {
  const state = createInitialState();
  state.shifts.push({ id: crypto.randomUUID(), shiftTypeId: 'evening', workDate: '2026-10-05', startTime: '16:00', endTime: '00:00', urgentOtHours: 0, note: '' });
  state.specialOtItems.push({ id: crypto.randomUUID(), workDate: '2026-10-05', hours: 2, note: 'เคสด่วน' });
  const plan = buildBulkPlan(state, selections([[DAY_OFF_TYPE, ['2026-10-05']]]));
  assert.deepEqual(plan.dayOffShiftConflicts, ['2026-10-05']);
  applyBulkPlan(state, plan);
  assert.equal(state.shifts.length, 0);
  assert.equal(state.dayOffs.length, 1);
  assert.equal(state.specialOtItems.length, 1);
});

test('adding a shift to day off reports a conflict and replaces only day off', () => {
  const state = createInitialState();
  state.dayOffs.push({ id: crypto.randomUUID(), workDate: '2026-10-06' });
  const plan = buildBulkPlan(state, selections([['morning', ['2026-10-06']]]));
  assert.deepEqual(plan.shiftDayOffConflicts, ['2026-10-06']);
  applyBulkPlan(state, plan);
  assert.equal(state.dayOffs.length, 0);
  assert.equal(state.shifts.length, 1);
});
