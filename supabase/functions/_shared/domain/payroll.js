import { normalizeShift, workedHoursWithoutOverlap } from './shift-time.js';

export function normalizePayrollInput({ settings = {}, shiftTypes = [], shifts = [], specialOtItems = [], dayOffs = [], financialItems = [] }) {
  return {
    settings: {
      salary: Number(settings.salary || 0),
      licenseAllowance: Number(settings.licenseAllowance ?? settings.license_allowance ?? 0),
      otRate: Number(settings.otRate ?? settings.ot_rate ?? 0),
      standardHours: Number(settings.standardHours ?? settings.standard_hours ?? 176)
    },
    shiftTypes: shiftTypes.map((type) => ({ id: type.id, name: type.name, premium: Number(type.premium || 0) })),
    shifts: shifts.map(normalizeShift),
    specialOtItems: specialOtItems.map((item) => ({
      workDate: item.workDate ?? item.work_date,
      hours: Math.floor(Number(item.hours || 0)),
      note: item.note || ''
    })),
    dayOffs: dayOffs.map((item) => ({ workDate: item.workDate ?? item.work_date })),
    financialItems: financialItems.map((item) => ({
      kind: item.kind,
      amount: Number(item.amount || 0),
      workDate: item.workDate ?? item.work_date
    }))
  };
}

export function calculatePayrollSummary(input) {
  const value = normalizePayrollInput(input);
  const workedHours = workedHoursWithoutOverlap(value.shifts);
  const normalOtHours = Math.max(0, workedHours - value.settings.standardHours);
  const specialOtHours = value.specialOtItems.reduce((sum, item) => sum + item.hours, 0);
  const types = new Map(value.shiftTypes.map((type) => [type.id, type]));
  const shiftIncome = value.shifts.reduce((sum, shift) => sum + Number(types.get(shift.shiftTypeId)?.premium || 0), 0);
  const normalOtIncome = normalOtHours * value.settings.otRate;
  const specialOtIncome = specialOtHours * value.settings.otRate;
  const otherIncome = value.financialItems.filter((item) => item.kind === 'income').reduce((sum, item) => sum + item.amount, 0);
  const deductions = value.financialItems.filter((item) => item.kind === 'deduction').reduce((sum, item) => sum + item.amount, 0);
  const gross = value.settings.salary + value.settings.licenseAllowance + shiftIncome + normalOtIncome + specialOtIncome + otherIncome;
  const shiftCounts = Object.fromEntries(value.shiftTypes.map((type) => [type.id, value.shifts.filter((shift) => shift.shiftTypeId === type.id).length]));

  return {
    workedHours,
    normalOtHours,
    specialOtHours,
    totalOtHours: normalOtHours + specialOtHours,
    shiftIncome,
    normalOtIncome,
    specialOtIncome,
    otIncome: normalOtIncome + specialOtIncome,
    otherIncome,
    deductions,
    gross,
    net: gross - deductions,
    shiftCounts,
    dayOffCount: value.dayOffs.length
  };
}
