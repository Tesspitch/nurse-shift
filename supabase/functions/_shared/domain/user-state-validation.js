function isFiniteNumber(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max;
}

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function assertUniqueIds(items) {
  const ids = items.map((item) => String(item.id || ''));
  if (new Set(ids).size !== ids.length) throw new Error('DUPLICATE_ID');
}

export function validateState(state) {
  if (!state || typeof state !== 'object') throw new Error('INVALID_STATE');
  if (!Number.isSafeInteger(Number(state.version)) || Number(state.version) < 0) throw new Error('INVALID_STATE');
  const settings = state.settings;
  if (!settings) throw new Error('INVALID_SETTINGS');
  for (const field of ['salary', 'licenseAllowance', 'otRate']) {
    if (!isFiniteNumber(settings[field], 0, 100_000_000)) throw new Error('INVALID_SETTINGS');
  }
  if (!isFiniteNumber(settings.uncertaintyBuffer, 0, 10_000_000)) throw new Error('INVALID_SETTINGS');
  if (!Number.isInteger(Number(settings.standardHours)) || !isFiniteNumber(settings.standardHours, 1, 744)) throw new Error('INVALID_STANDARD_HOURS');
  if (!Number.isInteger(Number(settings.cycleStartDay)) || !isFiniteNumber(settings.cycleStartDay, 1, 28)) throw new Error('INVALID_CYCLE_START_DAY');
  if (settings.confirmedCycle != null && !isDate(settings.confirmedCycle)) throw new Error('INVALID_SETTINGS');
  if (settings.expirationNotificationsEnabled != null && typeof settings.expirationNotificationsEnabled !== 'boolean') throw new Error('INVALID_SETTINGS');

  const { shiftTypes, shifts, specialOtItems, dayOffs, financialItems, reminders } = state;
  if (![shiftTypes, shifts, specialOtItems, dayOffs, financialItems, reminders].every(Array.isArray)) throw new Error('INVALID_COLLECTIONS');
  if (shiftTypes.length < 1 || shiftTypes.length > 20) throw new Error('SHIFT_TYPES_REQUIRED');
  if (shifts.length > 5000 || specialOtItems.length > 5000 || dayOffs.length > 5000 || financialItems.length > 5000 || reminders.length > 20) throw new Error('PAYLOAD_TOO_LARGE');
  [shiftTypes, shifts, specialOtItems, dayOffs, financialItems, reminders].forEach(assertUniqueIds);

  const typeIds = new Set();
  for (const type of shiftTypes) {
    if (typeof type.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(type.id)
      || typeof type.name !== 'string' || type.name.trim().length < 1 || type.name.length > 40
      || !isTime(type.startTime) || !isTime(type.endTime) || !isFiniteNumber(type.premium, 0, 10_000_000)
      || typeof type.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(type.color)) throw new Error('INVALID_SHIFT_TYPE');
    typeIds.add(type.id);
  }
  for (const shift of shifts) {
    if (typeof shift.id !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(shift.id)
      || typeof shift.shiftTypeId !== 'string' || !typeIds.has(shift.shiftTypeId)
      || !isDate(shift.workDate) || !isTime(shift.startTime) || !isTime(shift.endTime)
      || !Number.isInteger(Number(shift.urgentOtHours)) || !isFiniteNumber(shift.urgentOtHours, 0, 24)
      || typeof shift.note !== 'string' || shift.note.length > 120) throw new Error('INVALID_SHIFT');
  }
  for (const item of specialOtItems) {
    if (typeof item.id !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(item.id) || !isDate(item.workDate)
      || !Number.isInteger(Number(item.hours)) || !isFiniteNumber(item.hours, 1, 24)
      || typeof item.note !== 'string' || item.note.length > 120) throw new Error('INVALID_SPECIAL_OT_ITEM');
  }
  const dayOffDates = new Set();
  for (const item of dayOffs) {
    if (typeof item.id !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(item.id) || !isDate(item.workDate) || dayOffDates.has(item.workDate)) throw new Error('INVALID_DAY_OFF');
    dayOffDates.add(item.workDate);
  }
  if (shifts.some((shift) => dayOffDates.has(shift.workDate))) throw new Error('INVALID_DAY_OFF_CONFLICT');
  for (const item of financialItems) {
    if (typeof item.id !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(item.id) || !['income', 'deduction'].includes(item.kind)
      || typeof item.label !== 'string' || item.label.trim().length < 1 || item.label.length > 80
      || !isFiniteNumber(item.amount, 0, 100_000_000) || !isDate(item.workDate)) throw new Error('INVALID_FINANCIAL_ITEM');
  }
  for (const reminder of reminders) {
    if (typeof reminder.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(reminder.id)
      || !Number.isInteger(Number(reminder.offsetMinutes)) || !isFiniteNumber(reminder.offsetMinutes, 5, 43_200)
      || typeof reminder.enabled !== 'boolean') throw new Error('INVALID_REMINDER');
  }
}
