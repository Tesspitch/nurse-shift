const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function createCsv(state, payroll) {
  const typeNames = new Map(state.shiftTypes.map((type) => [type.id, type.name]));
  const rows = [
    ['ประเภทข้อมูล', 'วันที่', 'รายการ', 'เริ่ม', 'สิ้นสุด', 'ชั่วโมง OT เพิ่ม', 'จำนวนเงิน (บาท)', 'หมายเหตุ'],
    ...payroll.shifts.map((shift) => [
      'เวร', shift.workDate, typeNames.get(shift.shiftTypeId) || 'เวร', shift.startTime, shift.endTime,
      shift.urgentOtHours || 0, '', shift.note || ''
    ]),
    ...payroll.items.map((item) => [
      item.kind === 'deduction' ? 'รายการหัก' : 'รายรับ', item.workDate, item.label, '', '', '',
      item.kind === 'deduction' ? -Number(item.amount) : Number(item.amount), ''
    ]),
    [],
    ['สรุป', '', 'ยอดสุทธิโดยประมาณ', '', '', '', payroll.net, 'ไม่ใช่เอกสารรับรองจากนายจ้าง']
  ];
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function createBackup(state) {
  return {
    format: 'nurseshift-backup',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    data: {
      settings: structuredClone(state.settings),
      shiftTypes: structuredClone(state.shiftTypes),
      shifts: structuredClone(state.shifts),
      financialItems: structuredClone(state.financialItems),
      reminders: structuredClone(state.reminders)
    }
  };
}

function validDate(value) {
  if (!DATE_RE.test(String(value))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function restoreBackup(currentState, input) {
  if (!input || input.format !== 'nurseshift-backup' || input.formatVersion !== 1 || !input.data) {
    throw new Error('ไฟล์นี้ไม่ใช่ข้อมูลสำรองของ NurseShift');
  }
  const data = input.data;
  if (!data.settings || !Array.isArray(data.shiftTypes) || !Array.isArray(data.shifts)
      || !Array.isArray(data.financialItems) || !Array.isArray(data.reminders)) {
    throw new Error('ข้อมูลสำรองไม่ครบถ้วน');
  }
  if (data.shiftTypes.length < 1 || data.shiftTypes.length > 20 || data.shifts.length > 5000
      || data.financialItems.length > 5000 || data.reminders.length > 20) {
    throw new Error('ข้อมูลสำรองมีจำนวนรายการเกินขอบเขตที่รองรับ');
  }
  const typeIds = new Set(data.shiftTypes.map((type) => type.id));
  if (typeIds.size !== data.shiftTypes.length || data.shiftTypes.some((type) =>
    typeof type.id !== 'string' || typeof type.name !== 'string' || !TIME_RE.test(type.startTime)
    || !TIME_RE.test(type.endTime) || Number(type.premium) < 0)) throw new Error('ประเภทเวรในไฟล์ไม่ถูกต้อง');
  if (data.shifts.some((shift) => !typeIds.has(shift.shiftTypeId) || !validDate(shift.workDate)
      || !TIME_RE.test(shift.startTime) || !TIME_RE.test(shift.endTime))) throw new Error('รายการเวรในไฟล์ไม่ถูกต้อง');
  if (data.financialItems.some((item) => !['income', 'deduction'].includes(item.kind)
      || !validDate(item.workDate) || Number(item.amount) < 0)) throw new Error('รายการการเงินในไฟล์ไม่ถูกต้อง');
  if (data.reminders.some((reminder) => !Number.isInteger(Number(reminder.offsetMinutes))
      || Number(reminder.offsetMinutes) < 5 || Number(reminder.offsetMinutes) > 43200)) throw new Error('เวลาแจ้งเตือนในไฟล์ไม่ถูกต้อง');

  return {
    version: currentState.version,
    profile: currentState.profile,
    settings: structuredClone(data.settings),
    shiftTypes: structuredClone(data.shiftTypes),
    shifts: structuredClone(data.shifts),
    financialItems: structuredClone(data.financialItems),
    reminders: structuredClone(data.reminders)
  };
}

export function reminderLabel(offsetMinutes) {
  const minutes = Number(offsetMinutes);
  if (minutes % 1440 === 0) return `ก่อน ${minutes / 1440} วัน`;
  if (minutes % 60 === 0) return `ก่อน ${minutes / 60} ชั่วโมง`;
  return `ก่อน ${minutes} นาที`;
}
