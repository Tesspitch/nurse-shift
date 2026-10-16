export function removeSpecialOt(state, itemId) {
  state.specialOtItems = (state.specialOtItems || []).filter((item) => item.id !== itemId);
}
