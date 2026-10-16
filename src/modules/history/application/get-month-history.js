import { calculateMonthlyHistory, isAllowedHistoryMonth } from '../../../history.js';

export function createGetMonthHistory({ historyRepository, now = () => new Date() }) {
  if (!historyRepository?.getMonth) throw new TypeError('HistoryRepository.getMonth is required');

  return async function getMonthHistory({ userId = null, monthKey, currentState }) {
    if (!isAllowedHistoryMonth(monthKey, now())) {
      const error = new Error('เลือกดูได้เฉพาะเดือนปัจจุบันและ 2 เดือนก่อนหน้า');
      error.code = 'INVALID_HISTORY_MONTH';
      throw error;
    }
    const monthState = await historyRepository.getMonth(userId, monthKey);
    return calculateMonthlyHistory({ ...currentState, ...(monthState || {}) }, monthKey);
  };
}
