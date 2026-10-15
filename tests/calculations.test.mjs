import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePayroll, durationHours, shiftsOverlap, workedHoursWithoutOverlap } from '../src/calculations.js';
import { createInitialState } from '../src/seed.js';

test('counts full hours and supports overnight shifts', () => {
  assert.equal(durationHours('08:00', '16:00'), 8);
  assert.equal(durationHours('16:30', '00:45'), 8);
});

test('detects overlapping shifts including overnight work', () => {
  const night = { workDate: '2026-10-18', startTime: '20:00', endTime: '04:00' };
  const urgent = { workDate: '2026-10-19', startTime: '03:00', endTime: '05:00' };
  assert.equal(shiftsOverlap(night, urgent), true);
});

test('counts parallel shift ranges once while keeping separate shift records', () => {
  const shifts = [
    { workDate: '2026-10-01', startTime: '08:00', endTime: '16:00' },
    { workDate: '2026-10-01', startTime: '12:00', endTime: '20:00' }
  ];
  assert.equal(workedHoursWithoutOverlap(shifts), 12);
});

test('calculates salary, premiums, overtime and deductions for the current cycle', () => {
  const state = createInitialState();
  Object.assign(state.settings, { salary: 20000, licenseAllowance: 2000, otRate: 100, standardHours: 8 });
  state.shifts = [
    { id: '1', workDate: '2026-09-25', startTime: '08:00', endTime: '16:00', shiftTypeId: 'morning', urgentOtHours: 0 },
    { id: '2', workDate: '2026-10-01', startTime: '16:00', endTime: '00:00', shiftTypeId: 'evening', urgentOtHours: 0 }
  ];
  state.specialOtItems = [{ id: 'ot-1', workDate: '2026-10-01', hours: 1, note: 'เคสด่วน' }];
  state.financialItems = [
    { id: 'tax', workDate: '2026-10-01', kind: 'deduction', amount: 500 },
    { id: 'bonus', workDate: '2026-10-01', kind: 'income', amount: 1000 }
  ];

  const result = calculatePayroll(state, new Date(2026, 9, 15));
  assert.equal(result.workedHours, 16);
  assert.equal(result.automaticOtHours, 8);
  assert.equal(result.specialOtHours, 1);
  assert.equal(result.shiftPremium, 200);
  assert.equal(result.net, 23600);
  assert.equal(result.estimateLow, 23100);
  assert.equal(result.estimateHigh, 24100);
});

test('keeps configurable standard hours and counts special OT immediately without double counting', () => {
  const state = createInitialState();
  state.settings.otRate = 100;
  state.settings.standardHours = 176;
  state.specialOtItems = [{ id: 'special', workDate: '2026-10-01', hours: 8, note: '' }];
  const makeShifts = (count) => Array.from({ length: count }, (_, index) => ({
    id: String(index),
    workDate: `2026-10-${String(index + 1).padStart(2, '0')}`,
    startTime: '08:00',
    endTime: '16:00',
    shiftTypeId: 'morning',
    urgentOtHours: 0
  }));

  state.shifts = makeShifts(15);
  let payroll = calculatePayroll(state, new Date(2026, 9, 15));
  assert.equal(payroll.workedHours, 120);
  assert.equal(payroll.automaticOtHours, 0);
  assert.equal(payroll.specialOtHours, 8);

  state.shifts = makeShifts(22);
  payroll = calculatePayroll(state, new Date(2026, 9, 15));
  assert.equal(payroll.workedHours, 176);
  assert.equal(payroll.automaticOtHours, 0);
  assert.equal(payroll.specialOtHours, 8);

  state.shifts = makeShifts(23);
  payroll = calculatePayroll(state, new Date(2026, 9, 15));
  assert.equal(payroll.workedHours, 184);
  assert.equal(payroll.automaticOtHours, 8);
  assert.equal(payroll.specialOtHours, 8);
  assert.equal(payroll.otIncome, 1600);
});
