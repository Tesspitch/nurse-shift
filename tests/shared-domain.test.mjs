import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePayrollSummary, normalizePayrollInput } from '../supabase/functions/_shared/domain/payroll.js';
import { durationHours, shiftsOverlap, workedHoursWithoutOverlap } from '../supabase/functions/_shared/domain/shift-time.js';
import { bangkokMonthRange, monthRange } from '../supabase/functions/_shared/domain/bangkok-calendar.js';

const camelInput = {
  settings: { salary: 20000, licenseAllowance: 2000, otRate: 100, standardHours: 8 },
  shiftTypes: [{ id: 'evening', name: 'เวรบ่าย', premium: 200 }],
  shifts: [
    { shiftTypeId: 'evening', workDate: '2026-10-01', startTime: '16:00', endTime: '00:00' },
    { shiftTypeId: 'evening', workDate: '2026-10-01', startTime: '20:00', endTime: '02:00' }
  ],
  specialOtItems: [{ workDate: '2026-10-01', hours: 2 }],
  dayOffs: [{ workDate: '2026-10-02' }],
  financialItems: [{ kind: 'deduction', amount: 300, workDate: '2026-10-01' }]
};

test('canonical shift rules preserve overnight and overlap behavior', () => {
  assert.equal(durationHours('16:00', '00:00'), 8);
  assert.equal(shiftsOverlap(camelInput.shifts[0], camelInput.shifts[1]), true);
  assert.equal(workedHoursWithoutOverlap(camelInput.shifts), 10);
});

test('camelCase browser and snake_case database rows produce identical payroll', () => {
  const snakeInput = {
    settings: { salary: 20000, license_allowance: 2000, ot_rate: 100, standard_hours: 8 },
    shiftTypes: camelInput.shiftTypes,
    shifts: camelInput.shifts.map((item) => ({
      shift_type_id: item.shiftTypeId,
      work_date: item.workDate,
      start_time: item.startTime,
      end_time: item.endTime
    })),
    specialOtItems: [{ work_date: '2026-10-01', hours: 2 }],
    dayOffs: [{ work_date: '2026-10-02' }],
    financialItems: [{ kind: 'deduction', amount: 300, work_date: '2026-10-01' }]
  };
  assert.deepEqual(calculatePayrollSummary(snakeInput), calculatePayrollSummary(camelInput));
});

test('canonical payroll keeps 176 as the fallback while accepting configured hours', () => {
  assert.equal(normalizePayrollInput({ settings: {} }).settings.standardHours, 176);
  const configured = calculatePayrollSummary({
    ...camelInput,
    settings: { ...camelInput.settings, standardHours: 9 }
  });
  assert.equal(configured.workedHours, 10);
  assert.equal(configured.normalOtHours, 1);
  assert.equal(configured.specialOtHours, 2);
});

test('canonical Bangkok calendar handles leap months and local month boundaries', () => {
  assert.deepEqual(monthRange('2024-02'), { start: '2024-02-01', end: '2024-02-29' });
  assert.deepEqual(bangkokMonthRange(new Date('2026-09-30T18:00:00.000Z')), {
    monthKey: '2026-10', start: '2026-10-01', end: '2026-10-31'
  });
});
