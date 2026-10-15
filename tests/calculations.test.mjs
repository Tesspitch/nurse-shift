import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePayroll, durationHours, shiftsOverlap } from '../src/calculations.js';
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

test('calculates salary, premiums, overtime and deductions for the current cycle', () => {
  const state = createInitialState();
  Object.assign(state.settings, { salary: 20000, licenseAllowance: 2000, otRate: 100, standardHours: 8 });
  state.shifts = [
    { id: '1', workDate: '2026-09-25', startTime: '08:00', endTime: '16:00', shiftTypeId: 'morning', urgentOtHours: 1 },
    { id: '2', workDate: '2026-10-01', startTime: '16:00', endTime: '00:00', shiftTypeId: 'evening', urgentOtHours: 0 }
  ];
  state.financialItems = [
    { id: 'tax', workDate: '2026-10-01', kind: 'deduction', amount: 500 },
    { id: 'bonus', workDate: '2026-10-01', kind: 'income', amount: 1000 }
  ];

  const result = calculatePayroll(state, new Date(2026, 9, 15));
  assert.equal(result.workedHours, 16);
  assert.equal(result.automaticOtHours, 8);
  assert.equal(result.urgentOtHours, 1);
  assert.equal(result.shiftPremium, 200);
  assert.equal(result.net, 23600);
  assert.equal(result.estimateLow, 23100);
  assert.equal(result.estimateHigh, 24100);
});
