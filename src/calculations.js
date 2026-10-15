import { getCycleRange, toBangkokDateTime } from './date.js';

export function durationHours(startTime, endTime) {
  const [startHour, startMinute] = startTime.split(':').map(Number);
  const [endHour, endMinute] = endTime.split(':').map(Number);
  let minutes = endHour * 60 + endMinute - (startHour * 60 + startMinute);
  if (minutes <= 0) minutes += 24 * 60;
  return Math.floor(minutes / 60);
}

export function shiftsOverlap(first, second) {
  const firstStart = toBangkokDateTime(first.workDate, first.startTime);
  const firstEnd = toBangkokDateTime(first.workDate, first.endTime);
  if (firstEnd <= firstStart) firstEnd.setUTCDate(firstEnd.getUTCDate() + 1);

  const secondStart = toBangkokDateTime(second.workDate, second.startTime);
  const secondEnd = toBangkokDateTime(second.workDate, second.endTime);
  if (secondEnd <= secondStart) secondEnd.setUTCDate(secondEnd.getUTCDate() + 1);
  return firstStart < secondEnd && secondStart < firstEnd;
}

export function findOverlaps(candidate, shifts) {
  return shifts.filter((shift) => shift.id !== candidate.id && shiftsOverlap(candidate, shift));
}

export function calculatePayroll(state, anchorDate = new Date()) {
  const cycle = getCycleRange(anchorDate, state.settings.cycleStartDay);
  const shifts = state.shifts.filter((shift) => shift.workDate >= cycle.start && shift.workDate <= cycle.end);
  const shiftTypes = new Map(state.shiftTypes.map((type) => [type.id, type]));
  const items = state.financialItems.filter((item) => item.workDate >= cycle.start && item.workDate <= cycle.end);

  const workedHours = shifts.reduce((sum, shift) => sum + durationHours(shift.startTime, shift.endTime), 0);
  const automaticOtHours = Math.max(0, workedHours - Number(state.settings.standardHours || 0));
  const urgentOtHours = shifts.reduce((sum, shift) => sum + Math.floor(Number(shift.urgentOtHours || 0)), 0);
  const shiftPremium = shifts.reduce((sum, shift) => sum + Number(shiftTypes.get(shift.shiftTypeId)?.premium || 0), 0);
  const otherIncome = items.filter((item) => item.kind === 'income').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const deductions = items.filter((item) => item.kind === 'deduction').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const otIncome = (automaticOtHours + urgentOtHours) * Number(state.settings.otRate || 0);
  const gross = Number(state.settings.salary || 0)
    + Number(state.settings.licenseAllowance || 0)
    + shiftPremium
    + otIncome
    + otherIncome;
  const net = gross - deductions;
  const buffer = Number(state.settings.uncertaintyBuffer || 500);

  return {
    cycle,
    shifts,
    items,
    workedHours,
    automaticOtHours,
    urgentOtHours,
    shiftPremium,
    otherIncome,
    deductions,
    otIncome,
    gross,
    net,
    estimateLow: net - buffer,
    estimateHigh: net + buffer,
    confirmed: Boolean(state.settings.confirmedCycle === cycle.start)
  };
}
