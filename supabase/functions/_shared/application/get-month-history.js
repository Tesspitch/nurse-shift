import { bangkokMonthKey, monthRange, shiftMonthKey } from '../domain/bangkok-calendar.js';

export function createGetMonthHistory({ historyRepository, now = () => new Date() }) {
  if (!historyRepository?.getMonth) throw new TypeError('HistoryRepository.getMonth is required');

  return async function getMonthHistory(userId, monthKey) {
    if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(monthKey)) throw new Error('INVALID_HISTORY_MONTH');
    const current = bangkokMonthKey(now());
    if (![shiftMonthKey(current, -2), shiftMonthKey(current, -1), current].includes(monthKey)) {
      throw new Error('INVALID_HISTORY_MONTH');
    }
    return historyRepository.getMonth(userId, monthRange(monthKey));
  };
}
