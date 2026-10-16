import { bangkokMonthKey, monthRange, shiftMonthKey } from '../supabase/functions/_shared/domain/bangkok-calendar.js';
import { calculatePayrollSummary } from '../supabase/functions/_shared/domain/payroll.js';

export { bangkokMonthKey, monthRange, shiftMonthKey };

export function allowedHistoryMonths(date = new Date()) {
  const current = bangkokMonthKey(date);
  return [shiftMonthKey(current, -2), shiftMonthKey(current, -1), current];
}

export function isAllowedHistoryMonth(monthKey, date = new Date()) {
  return allowedHistoryMonths(date).includes(monthKey);
}

export function calculateMonthlyHistory(state, monthKey) {
  const range = monthRange(monthKey);
  const inMonth = (item) => item.workDate >= range.start && item.workDate <= range.end;
  const shifts = (state.shifts || []).filter(inMonth);
  const specialOtItems = (state.specialOtItems || []).filter(inMonth);
  const dayOffs = (state.dayOffs || []).filter(inMonth);
  const financialItems = (state.financialItems || []).filter(inMonth);
  const summary = calculatePayrollSummary({ settings: state.settings, shiftTypes: state.shiftTypes, shifts, specialOtItems, dayOffs, financialItems });

  return {
    monthKey,
    range,
    shifts,
    specialOtItems,
    dayOffs,
    financialItems,
    ...summary,
    hasActivity: Boolean(shifts.length || specialOtItems.length || dayOffs.length || financialItems.length)
  };
}
