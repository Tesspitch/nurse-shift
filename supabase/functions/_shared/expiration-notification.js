const MONTH_FORMAT = new Intl.DateTimeFormat('th-TH-u-ca-buddhist', { month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok' });
const DATE_FORMAT = new Intl.DateTimeFormat('th-TH-u-ca-buddhist', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok' });

function bangkokParts(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(value instanceof Date ? value : new Date(value));
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function localDate(year, month, day, hour = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour - 7));
}

export function expirationPlan(reference = new Date()) {
  const current = bangkokParts(reference);
  const currentMonth = new Date(Date.UTC(current.year, current.month - 1, 1));
  const expiring = new Date(Date.UTC(current.year, current.month - 3, 1));
  const expiryMonth = new Date(Date.UTC(current.year, current.month, 1));
  const expiryDate = localDate(expiryMonth.getUTCFullYear(), expiryMonth.getUTCMonth() + 1, 1);
  const notices = [7, 3, 1].map((daysBefore) => ({
    daysBefore,
    scheduledFor: new Date(expiryDate.getTime() - daysBefore * 86_400_000 + 9 * 3_600_000)
  }));
  return {
    allowedMonths: [-2, -1, 0].map((offset) => {
      const date = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() + offset, 1));
      return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    }),
    expiringMonth: `${expiring.getUTCFullYear()}-${String(expiring.getUTCMonth() + 1).padStart(2, '0')}`,
    expiryDate: expiryDate.toISOString(),
    notices
  };
}

export function createExpirationMessage({ expiringMonth, expiryDate, daysBefore, liffUrl = '' }) {
  const monthDate = new Date(`${expiringMonth}-01T00:00:00+07:00`);
  const expiry = new Date(expiryDate);
  const title = daysBefore === 1 ? 'NurseShift — แจ้งเตือนครั้งสุดท้าย' : 'NurseShift — แจ้งเตือนข้อมูลย้อนหลัง';
  const timing = daysBefore === 1 ? 'จะพ้นช่วงแสดงผลในวันพรุ่งนี้' : `จะพ้นช่วงแสดงผลในอีก ${daysBefore} วัน`;
  const action = daysBefore === 1
    ? 'กรุณาตรวจสอบข้อมูลของคุณก่อนครบกำหนด'
    : `กรุณาตรวจสอบหรือสำรองข้อมูลที่ต้องการเก็บไว้ก่อนวันที่ ${DATE_FORMAT.format(expiry)}`;
  return `${title}\n\nข้อมูลตารางเวรของเดือน${MONTH_FORMAT.format(monthDate)} ${timing}\n\n${action}${liffUrl ? `\n\nเปิด NurseShift: ${liffUrl}` : ''}`;
}

