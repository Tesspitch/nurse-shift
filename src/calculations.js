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

export function workedHoursWithoutOverlap(shifts) {
  const ranges = shifts.map((shift) => {
    const start = toBangkokDateTime(shift.workDate, shift.startTime);
    const end = toBangkokDateTime(shift.workDate, shift.endTime);
    if (end <= start) end.setUTCDate(end.getUTCDate() + 1);
    return [start.getTime(), end.getTime()];
  }).sort((a, b) => a[0] - b[0]);

  let totalMinutes = 0;
  let activeStart = null;
  let activeEnd = null;
  for (const [start, end] of ranges) {
    if (activeStart === null) {
      activeStart = start;
      activeEnd = end;
      continue;
    }
    if (start <= activeEnd) {
      activeEnd = Math.max(activeEnd, end);
      continue;
    }
    totalMinutes += (activeEnd - activeStart) / 60_000;
    activeStart = start;
    activeEnd = end;
  }
  if (activeStart !== null) totalMinutes += (activeEnd - activeStart) / 60_000;
  return Math.floor(totalMinutes / 60);
}

export function calculatePayroll(state, anchorDate = new Date()) {
  const cycle = getCycleRange(anchorDate, state.settings.cycleStartDay);
  const shifts = state.shifts.filter((shift) => shift.workDate >= cycle.start && shift.workDate <= cycle.end);
  const specialOtItems = Array.isArray(state.specialOtItems)
    ? state.specialOtItems.filter((item) => item.workDate >= cycle.start && item.workDate <= cycle.end)
    : shifts
      .filter((shift) => Number(shift.urgentOtHours || 0) > 0)
      .map((shift) => ({ workDate: shift.workDate, hours: Math.floor(Number(shift.urgentOtHours)), note: shift.note || '' }));
  const shiftTypes = new Map(state.shiftTypes.map((type) => [type.id, type]));
  const items = state.financialItems.filter((item) => item.workDate >= cycle.start && item.workDate <= cycle.end);

  const workedHours = workedHoursWithoutOverlap(shifts);
  const automaticOtHours = Math.max(0, workedHours - Number(state.settings.standardHours || 0));
  const specialOtHours = specialOtItems.reduce((sum, item) => sum + Math.floor(Number(item.hours || 0)), 0);
  const shiftPremium = shifts.reduce((sum, shift) => sum + Number(shiftTypes.get(shift.shiftTypeId)?.premium || 0), 0);
  const otherIncome = items.filter((item) => item.kind === 'income').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const deductions = items.filter((item) => item.kind === 'deduction').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const otIncome = (automaticOtHours + specialOtHours) * Number(state.settings.otRate || 0);
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
    specialOtItems,
    items,
    workedHours,
    automaticOtHours,
    specialOtHours,
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
