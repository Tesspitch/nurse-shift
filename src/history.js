import { workedHoursWithoutOverlap } from './calculations.js';

const MONTH_KEY_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;

export function bangkokMonthKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit'
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  return `${year}-${month}`;
}

export function shiftMonthKey(monthKey, amount) {
  if (!MONTH_KEY_RE.test(monthKey)) throw new Error('INVALID_MONTH');
  const [year, month] = monthKey.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function allowedHistoryMonths(date = new Date()) {
  const current = bangkokMonthKey(date);
  return [shiftMonthKey(current, -2), shiftMonthKey(current, -1), current];
}

export function monthRange(monthKey) {
  if (!MONTH_KEY_RE.test(monthKey)) throw new Error('INVALID_MONTH');
  const nextMonth = shiftMonthKey(monthKey, 1);
  const [nextYear, nextMonthNumber] = nextMonth.split('-').map(Number);
  const end = new Date(Date.UTC(nextYear, nextMonthNumber - 1, 0));
  return { start: `${monthKey}-01`, end: end.toISOString().slice(0, 10) };
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
  const shiftTypes = new Map((state.shiftTypes || []).map((type) => [type.id, type]));
  const workedHours = workedHoursWithoutOverlap(shifts);
  const normalOtHours = Math.max(0, workedHours - Number(state.settings.standardHours || 0));
  const specialOtHours = specialOtItems.reduce((sum, item) => sum + Math.floor(Number(item.hours || 0)), 0);
  const shiftIncome = shifts.reduce((sum, shift) => sum + Number(shiftTypes.get(shift.shiftTypeId)?.premium || 0), 0);
  const normalOtIncome = normalOtHours * Number(state.settings.otRate || 0);
  const specialOtIncome = specialOtHours * Number(state.settings.otRate || 0);
  const otherIncome = financialItems.filter((item) => item.kind === 'income').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const deductions = financialItems.filter((item) => item.kind === 'deduction').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const gross = Number(state.settings.salary || 0) + Number(state.settings.licenseAllowance || 0)
    + shiftIncome + normalOtIncome + specialOtIncome + otherIncome;
  const net = gross - deductions;
  const shiftCounts = Object.fromEntries((state.shiftTypes || []).map((type) => [type.id, shifts.filter((shift) => shift.shiftTypeId === type.id).length]));

  return {
    monthKey,
    range,
    shifts,
    specialOtItems,
    dayOffs,
    financialItems,
    workedHours,
    normalOtHours,
    specialOtHours,
    totalOtHours: normalOtHours + specialOtHours,
    shiftIncome,
    normalOtIncome,
    specialOtIncome,
    otherIncome,
    deductions,
    gross,
    net,
    shiftCounts,
    hasActivity: Boolean(shifts.length || specialOtItems.length || dayOffs.length || financialItems.length)
  };
}
