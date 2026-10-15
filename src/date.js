export const THAI_YEAR_OFFSET = 543;

export function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function fromIsoDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function formatThaiDate(value, includeWeekday = false) {
  const date = typeof value === 'string' ? fromIsoDate(value) : value;
  return new Intl.DateTimeFormat('th-TH-u-ca-buddhist', {
    weekday: includeWeekday ? 'short' : undefined,
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(date);
}

export function formatDateInput(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${Number(year) + THAI_YEAR_OFFSET}`;
}

export function maskDateInput(value) {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

export function parseDateInput(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return null;
  const [, dayText, monthText, buddhistYearText] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  const year = Number(buddhistYearText) - THAI_YEAR_OFFSET;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return toIsoDate(date);
}

export function getCycleRange(anchorDate, startDay) {
  const anchor = typeof anchorDate === 'string' ? fromIsoDate(anchorDate) : new Date(anchorDate);
  const safeDay = Math.min(Math.max(Number(startDay) || 1, 1), 28);
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), safeDay);
  if (anchor < start) start.setMonth(start.getMonth() - 1);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, safeDay - 1);
  return { start: toIsoDate(start), end: toIsoDate(end) };
}

export function shiftMonth(date, amount) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

export function calendarCells(monthDate) {
  const first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const gridStart = new Date(first);
  gridStart.setDate(1 - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    return {
      iso: toIsoDate(date),
      day: date.getDate(),
      currentMonth: date.getMonth() === monthDate.getMonth()
    };
  });
}

export function thaiMonthYear(date) {
  return new Intl.DateTimeFormat('th-TH-u-ca-buddhist', { month: 'long', year: 'numeric' }).format(date);
}

export function toBangkokDateTime(isoDate, time) {
  return new Date(`${isoDate}T${time}:00+07:00`);
}
