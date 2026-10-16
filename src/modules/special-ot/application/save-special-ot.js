const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createSpecialOtItem(input, idFactory = () => crypto.randomUUID()) {
  const hours = Number(input.hours);
  if (!ISO_DATE.test(input.workDate || '')) {
    const error = new Error('กรุณากรอกวันที่ให้ถูกต้อง เช่น 18/10/2569');
    error.code = 'INVALID_SPECIAL_OT_DATE';
    throw error;
  }
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) {
    const error = new Error('OT พิเศษต้องเป็นจำนวนเต็ม 1–24 ชั่วโมง');
    error.code = 'INVALID_SPECIAL_OT_HOURS';
    throw error;
  }
  return {
    id: input.id || idFactory(),
    workDate: input.workDate,
    hours,
    note: String(input.note || '').trim()
  };
}

export function saveSpecialOt(state, item) {
  if (!Array.isArray(state.specialOtItems)) state.specialOtItems = [];
  const index = state.specialOtItems.findIndex((entry) => entry.id === item.id);
  if (index >= 0) state.specialOtItems[index] = item;
  else state.specialOtItems.push(item);
}
