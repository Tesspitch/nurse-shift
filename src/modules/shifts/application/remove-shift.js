export function removeShift(state, shiftId) {
  state.shifts = state.shifts.filter((shift) => shift.id !== shiftId);
}
