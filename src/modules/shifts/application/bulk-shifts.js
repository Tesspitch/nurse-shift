import { shiftsOverlap } from '../../../../supabase/functions/_shared/domain/shift-time.js';

export const DAY_OFF_TYPE = 'day-off';

function selectedDates(selections, typeId) {
  const value = selections.get(typeId);
  return value instanceof Set ? [...value] : Array.isArray(value) ? value : [];
}

export function buildBulkPlan(state, selections, idFactory = () => crypto.randomUUID(), removalSelections = new Map()) {
  const existingDayOffDates = new Set((state.dayOffs || []).map((item) => item.workDate));
  const shiftTypes = new Map(state.shiftTypes.map((type) => [type.id, type]));
  const shifts = [];
  const shiftRemovals = [];
  const dayOffs = [];
  const duplicates = [];
  const overlaps = [];
  const shiftDayOffConflicts = new Set();
  const dayOffShiftConflicts = new Set();
  const removalIds = new Set();

  for (const type of state.shiftTypes) {
    const selectedRemovalDates = new Set(selectedDates(removalSelections, type.id));
    for (const shift of state.shifts) {
      if (shift.shiftTypeId === type.id && selectedRemovalDates.has(shift.workDate)) {
        shiftRemovals.push(shift);
        removalIds.add(shift.id);
      }
    }
  }

  for (const type of state.shiftTypes) {
    for (const workDate of selectedDates(selections, type.id).sort()) {
      if (state.shifts.some((shift) => shift.workDate === workDate && shift.shiftTypeId === type.id)) {
        duplicates.push({ workDate, typeId: type.id });
        continue;
      }
      if (existingDayOffDates.has(workDate)) shiftDayOffConflicts.add(workDate);
      const candidate = {
        id: idFactory(), shiftTypeId: type.id, workDate,
        startTime: type.startTime, endTime: type.endTime, urgentOtHours: 0, note: ''
      };
      const collided = [...state.shifts, ...shifts].filter((shift) => !removalIds.has(shift.id)
        && shift.workDate === workDate && shiftsOverlap(candidate, shift));
      if (collided.length) overlaps.push({ candidate, shifts: collided });
      shifts.push(candidate);
    }
  }

  for (const workDate of selectedDates(selections, DAY_OFF_TYPE).sort()) {
    if (existingDayOffDates.has(workDate)) {
      duplicates.push({ workDate, typeId: DAY_OFF_TYPE });
      continue;
    }
    if (state.shifts.some((shift) => shift.workDate === workDate)) dayOffShiftConflicts.add(workDate);
    dayOffs.push({ id: idFactory(), workDate });
  }

  return {
    shifts, shiftRemovals, dayOffs, duplicates, overlaps,
    shiftDayOffConflicts: [...shiftDayOffConflicts].sort(),
    dayOffShiftConflicts: [...dayOffShiftConflicts].sort(),
    shiftTypes
  };
}

export function applyBulkPlan(state, plan) {
  const removeShiftIds = new Set((plan.shiftRemovals || []).map((shift) => shift.id));
  const removeDayOffDates = new Set(plan.shiftDayOffConflicts);
  const removeShiftDates = new Set(plan.dayOffShiftConflicts);
  state.dayOffs = (state.dayOffs || []).filter((item) => !removeDayOffDates.has(item.workDate));
  state.shifts = state.shifts.filter((shift) => !removeShiftIds.has(shift.id) && !removeShiftDates.has(shift.workDate));
  state.shifts.push(...plan.shifts);
  state.dayOffs.push(...plan.dayOffs);
}
