export function removeDayOff(state, dayOffId) {
  state.dayOffs = (state.dayOffs || []).filter((item) => item.id !== dayOffId);
}
