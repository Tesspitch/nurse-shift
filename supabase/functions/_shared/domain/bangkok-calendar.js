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

export function monthRange(monthKey) {
  if (!MONTH_KEY_RE.test(monthKey)) throw new Error('INVALID_MONTH');
  const nextMonth = shiftMonthKey(monthKey, 1);
  const [nextYear, nextMonthNumber] = nextMonth.split('-').map(Number);
  const end = new Date(Date.UTC(nextYear, nextMonthNumber - 1, 0));
  return { start: `${monthKey}-01`, end: end.toISOString().slice(0, 10) };
}

export function bangkokMonthRange(date = new Date()) {
  const monthKey = bangkokMonthKey(date);
  return { monthKey, ...monthRange(monthKey) };
}
