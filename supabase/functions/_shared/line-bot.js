import { bangkokMonthRange } from './domain/bangkok-calendar.js';
import { calculatePayrollSummary } from './domain/payroll.js';
import { workedHoursWithoutOverlap } from './domain/shift-time.js';

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

export { bangkokMonthRange, workedHoursWithoutOverlap };

export function calculateBotMonthSummary({ settings, shiftTypes = [], shifts = [], specialOtItems = [], dayOffs = [], financialItems = [] }) {
  return calculatePayrollSummary({ settings, shiftTypes, shifts, specialOtItems, dayOffs, financialItems });
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
