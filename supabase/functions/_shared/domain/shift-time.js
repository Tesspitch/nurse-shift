const BANGKOK_OFFSET = '+07:00';

export function normalizeShift(shift) {
  return {
    id: shift.id,
    shiftTypeId: shift.shiftTypeId ?? shift.shift_type_id,
    workDate: shift.workDate ?? shift.work_date,
    startTime: String(shift.startTime ?? shift.start_time ?? '').slice(0, 5),
    endTime: String(shift.endTime ?? shift.end_time ?? '').slice(0, 5),
    note: shift.note || ''
  };
}

export function shiftRange(shift) {
  const value = normalizeShift(shift);
  const start = new Date(`${value.workDate}T${value.startTime}:00${BANGKOK_OFFSET}`).getTime();
  let end = new Date(`${value.workDate}T${value.endTime}:00${BANGKOK_OFFSET}`).getTime();
  if (end <= start) end += 86_400_000;
  return [start, end];
}

export function durationHours(startTime, endTime) {
  const [startHour, startMinute] = startTime.split(':').map(Number);
  const [endHour, endMinute] = endTime.split(':').map(Number);
  let minutes = endHour * 60 + endMinute - (startHour * 60 + startMinute);
  if (minutes <= 0) minutes += 24 * 60;
  return Math.floor(minutes / 60);
}

export function shiftsOverlap(first, second) {
  const [firstStart, firstEnd] = shiftRange(first);
  const [secondStart, secondEnd] = shiftRange(second);
  return firstStart < secondEnd && secondStart < firstEnd;
}

export function workedHoursWithoutOverlap(shifts = []) {
  const ranges = shifts.map(shiftRange).sort((first, second) => first[0] - second[0]);
  let totalMinutes = 0;
  let activeStart = null;
  let activeEnd = null;

  for (const [start, end] of ranges) {
    if (activeStart === null) {
      activeStart = start;
      activeEnd = end;
    } else if (start <= activeEnd) {
      activeEnd = Math.max(activeEnd, end);
    } else {
      totalMinutes += (activeEnd - activeStart) / 60_000;
      activeStart = start;
      activeEnd = end;
    }
  }
  if (activeStart !== null) totalMinutes += (activeEnd - activeStart) / 60_000;
  return Math.floor(totalMinutes / 60);
}
