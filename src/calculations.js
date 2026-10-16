import { getCycleRange } from './date.js';
import {
  durationHours,
  shiftsOverlap,
  workedHoursWithoutOverlap
} from '../supabase/functions/_shared/domain/shift-time.js';
import { calculatePayrollSummary } from '../supabase/functions/_shared/domain/payroll.js';

export { durationHours, shiftsOverlap, workedHoursWithoutOverlap };

export function findOverlaps(candidate, shifts) {
  return shifts.filter((shift) => shift.id !== candidate.id && shiftsOverlap(candidate, shift));
}

export function calculatePayroll(state, anchorDate = new Date()) {
  const cycle = getCycleRange(anchorDate, state.settings.cycleStartDay);
  const shifts = state.shifts.filter((shift) => shift.workDate >= cycle.start && shift.workDate <= cycle.end);
  const specialOtItems = Array.isArray(state.specialOtItems)
    ? state.specialOtItems.filter((item) => item.workDate >= cycle.start && item.workDate <= cycle.end)
    : shifts
      .filter((shift) => Number(shift.urgentOtHours || 0) > 0)
      .map((shift) => ({ workDate: shift.workDate, hours: Math.floor(Number(shift.urgentOtHours)), note: shift.note || '' }));
  const items = state.financialItems.filter((item) => item.workDate >= cycle.start && item.workDate <= cycle.end);
  const summary = calculatePayrollSummary({ settings: state.settings, shiftTypes: state.shiftTypes, shifts, specialOtItems, financialItems: items });
  const buffer = Number(state.settings.uncertaintyBuffer || 500);

  return {
    cycle,
    shifts,
    specialOtItems,
    items,
    workedHours: summary.workedHours,
    automaticOtHours: summary.normalOtHours,
    specialOtHours: summary.specialOtHours,
    shiftPremium: summary.shiftIncome,
    otherIncome: summary.otherIncome,
    deductions: summary.deductions,
    otIncome: summary.otIncome,
    gross: summary.gross,
    net: summary.net,
    estimateLow: summary.net - buffer,
    estimateHigh: summary.net + buffer,
    confirmed: Boolean(state.settings.confirmedCycle === cycle.start)
  };
}
