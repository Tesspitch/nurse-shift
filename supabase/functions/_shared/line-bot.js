export const BOT_ACTIONS = new Set(['next_shift', 'monthly_income', 'ot_summary', 'day_off', 'monthly_shifts', 'help']);

export function parsePostbackAction(data = '') {
  const action = new URLSearchParams(data).get('action') || '';
  return BOT_ACTIONS.has(action) ? action : null;
}

export function canShowActionInSource(action, sourceType) {
  return action !== 'monthly_income' || sourceType === 'user';
}

export async function verifyLineSignature(rawBody, signature, channelSecret, subtle = crypto.subtle) {
  if (!signature || !channelSecret) return false;
  const encoder = new TextEncoder();
  const key = await subtle.importKey('raw', encoder.encode(channelSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await subtle.sign('HMAC', key, encoder.encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(digest)));
  if (expected.length !== signature.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  return difference === 0;
}

export function bangkokMonthRange(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  const year = Number(value('year'));
  const month = Number(value('month'));
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { monthKey: start.slice(0, 7), start, end };
}

function shiftRange(shift) {
  const start = new Date(`${shift.work_date}T${String(shift.start_time).slice(0, 5)}:00+07:00`).getTime();
  let end = new Date(`${shift.work_date}T${String(shift.end_time).slice(0, 5)}:00+07:00`).getTime();
  if (end <= start) end += 86_400_000;
  return [start, end];
}

export function workedHoursWithoutOverlap(shifts = []) {
  const ranges = shifts.map(shiftRange).sort((first, second) => first[0] - second[0]);
  let minutes = 0;
  let activeStart = null;
  let activeEnd = null;
  for (const [start, end] of ranges) {
    if (activeStart === null) {
      activeStart = start;
      activeEnd = end;
    } else if (start <= activeEnd) {
      activeEnd = Math.max(activeEnd, end);
    } else {
      minutes += (activeEnd - activeStart) / 60_000;
      activeStart = start;
      activeEnd = end;
    }
  }
  if (activeStart !== null) minutes += (activeEnd - activeStart) / 60_000;
  return Math.floor(minutes / 60);
}

export function calculateBotMonthSummary({ settings, shiftTypes = [], shifts = [], specialOtItems = [], dayOffs = [], financialItems = [] }) {
  const workedHours = workedHoursWithoutOverlap(shifts);
  const standardHours = Number(settings.standard_hours || 176);
  const normalOtHours = Math.max(0, workedHours - standardHours);
  const specialOtHours = specialOtItems.reduce((sum, item) => sum + Math.floor(Number(item.hours || 0)), 0);
  const types = new Map(shiftTypes.map((type) => [type.id, type]));
  const shiftIncome = shifts.reduce((sum, shift) => sum + Number(types.get(shift.shift_type_id)?.premium || 0), 0);
  const normalOtIncome = normalOtHours * Number(settings.ot_rate || 0);
  const specialOtIncome = specialOtHours * Number(settings.ot_rate || 0);
  const otherIncome = financialItems.filter((item) => item.kind === 'income').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const deductions = financialItems.filter((item) => item.kind === 'deduction').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const gross = Number(settings.salary || 0) + Number(settings.license_allowance || 0) + shiftIncome + normalOtIncome + specialOtIncome + otherIncome;
  const shiftCounts = Object.fromEntries(shiftTypes.map((type) => [type.id, shifts.filter((shift) => shift.shift_type_id === type.id).length]));
  return { workedHours, normalOtHours, specialOtHours, totalOtHours: normalOtHours + specialOtHours, shiftIncome, normalOtIncome, specialOtIncome, otIncome: normalOtIncome + specialOtIncome, otherIncome, deductions, gross, net: gross - deductions, shiftCounts, dayOffCount: dayOffs.length };
}

const money = (value) => `${new Intl.NumberFormat('th-TH', { maximumFractionDigits: 2 }).format(Number(value || 0))} บาท`;
const thaiDate = (value) => new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium' }).format(new Date(`${value}T12:00:00+07:00`));
const row = (label, value) => ({ type: 'box', layout: 'horizontal', margin: 'md', contents: [
  { type: 'text', text: label, size: 'sm', color: '#775160', flex: 5, wrap: true },
  { type: 'text', text: String(value), size: 'sm', color: '#34232B', weight: 'bold', align: 'end', flex: 6, wrap: true }
] });

export function createFlexMessage(action, data, liffUrl) {
  const content = [];
  let title = 'NurseShift';
  let screen = 'home';
  if (action === 'next_shift') {
    title = 'เวรถัดไป'; screen = 'calendar';
    if (data.shift) {
      content.push(row('วันที่', thaiDate(data.shift.work_date)), row('ประเภทเวร', data.shift.shift_name), row('เวลา', `${String(data.shift.start_time).slice(0, 5)}–${String(data.shift.end_time).slice(0, 5)} น.`));
    } else content.push({ type: 'text', text: 'ยังไม่มีเวรถัดไปในตาราง', size: 'sm', color: '#775160', wrap: true });
  } else if (action === 'monthly_income') {
    title = `รายได้ ${data.monthLabel}`; screen = 'finance';
    content.push(row('รายได้รวม', money(data.summary.gross)), row('ค่าเวร', money(data.summary.shiftIncome)), row('OT ปกติ', money(data.summary.normalOtIncome)), row('OT พิเศษ', money(data.summary.specialOtIncome)), row('รายได้สุทธิประมาณ', money(data.summary.net)));
  } else if (action === 'ot_summary') {
    title = `สรุป OT ${data.monthLabel}`; screen = 'finance';
    content.push(row('ชั่วโมงทำงาน', `${data.summary.workedHours} ชม.`), row('OT ปกติ', `${data.summary.normalOtHours} ชม.`), row('OT พิเศษ', `${data.summary.specialOtHours} ชม.`), row('OT รวม', `${data.summary.totalOtHours} ชม.`), row('รายได้ OT', money(data.summary.otIncome)));
  } else if (action === 'day_off') {
    title = `วันหยุด ${data.monthLabel}`; screen = 'calendar';
    content.push(row('จำนวนวันหยุด', `${data.dayOffs.length} วัน`));
    content.push({ type: 'text', text: data.dayOffs.length ? data.dayOffs.map((item) => thaiDate(item.work_date)).join('\n') : 'ยังไม่มีวันหยุดในเดือนนี้', margin: 'md', size: 'sm', color: '#775160', wrap: true });
  } else if (action === 'monthly_shifts') {
    title = `สรุปเวร ${data.monthLabel}`; screen = 'history';
    for (const type of data.shiftTypes) content.push(row(type.name, `${data.summary.shiftCounts[type.id] || 0} เวร`));
    content.push(row('วันหยุด', `${data.summary.dayOffCount} วัน`), row('ชั่วโมงทำงานรวม', `${data.summary.workedHours} ชม.`));
  } else {
    title = 'วิธีใช้งาน NurseShift';
    content.push({ type: 'text', text: '• เพิ่มเวรจากหน้าตารางเวร\n• เลือกหลายวันหรือวันหยุดได้ในครั้งเดียว\n• เพิ่ม OT พิเศษจากวันที่เลือก\n• ดูรายได้ที่หน้าการเงิน\n• ดูย้อนหลังได้ 3 เดือน', size: 'sm', color: '#5F4651', wrap: true, lineSpacing: '5px' });
  }
  return {
    type: 'flex', altText: title,
    contents: { type: 'bubble', styles: { header: { backgroundColor: '#F9DCE7' }, footer: { separator: true } },
      header: { type: 'box', layout: 'vertical', paddingAll: '20px', contents: [{ type: 'text', text: title, weight: 'bold', size: 'lg', color: '#8D345B', wrap: true }] },
      body: { type: 'box', layout: 'vertical', paddingAll: '20px', contents: content },
      footer: { type: 'box', layout: 'vertical', paddingAll: '14px', contents: [{ type: 'button', style: 'primary', color: '#B54478', action: { type: 'uri', label: 'เปิด NurseShift', uri: `${liffUrl}?screen=${screen}` } }] }
    }
  };
}
