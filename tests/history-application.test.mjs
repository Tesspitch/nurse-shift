import test from 'node:test';
import assert from 'node:assert/strict';
import { createGetMonthHistory } from '../src/modules/history/application/get-month-history.js';
import { CachedHistoryRepository } from '../src/infrastructure/history/cached-history-repository.js';
import { createInitialState } from '../src/seed.js';

test('GetMonthHistory depends on repository port and keeps the three-month policy', async () => {
  const calls = [];
  const repository = { async getMonth(userId, monthKey) { calls.push({ userId, monthKey }); return null; } };
  const getMonthHistory = createGetMonthHistory({
    historyRepository: repository,
    now: () => new Date('2026-10-15T12:00:00+07:00')
  });
  const result = await getMonthHistory({ userId: 'user-1', monthKey: '2026-08', currentState: createInitialState() });
  assert.equal(result.monthKey, '2026-08');
  assert.deepEqual(calls, [{ userId: 'user-1', monthKey: '2026-08' }]);
  await assert.rejects(
    () => getMonthHistory({ userId: 'user-1', monthKey: '2026-07', currentState: createInitialState() }),
    (error) => error.code === 'INVALID_HISTORY_MONTH'
  );
});

test('CachedHistoryRepository deduplicates concurrent reads and returns defensive copies', async () => {
  let calls = 0;
  let resolveLoad;
  const pending = new Promise((resolve) => { resolveLoad = resolve; });
  const repository = new CachedHistoryRepository({
    loadMonth: async () => { calls += 1; return pending; }
  });
  const first = repository.getMonth('user-1', '2026-10');
  const second = repository.getMonth('user-1', '2026-10');
  resolveLoad({ shifts: [{ id: 'shift-1' }] });
  const [firstValue, secondValue] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  firstValue.shifts[0].id = 'changed';
  assert.equal(secondValue.shifts[0].id, 'shift-1');
  assert.equal((await repository.getMonth('user-1', '2026-10')).shifts[0].id, 'shift-1');

  repository.clear();
  await repository.getMonth('user-1', '2026-10');
  assert.equal(calls, 2);
});
