import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBulkPlan, applyBulkPlan, DAY_OFF_TYPE } from '../src/modules/shifts/application/bulk-shifts.js';
import { removeShift } from '../src/modules/shifts/application/remove-shift.js';
import { removeDayOff } from '../src/modules/day-off/application/remove-day-off.js';
import { createSpecialOtItem, saveSpecialOt } from '../src/modules/special-ot/application/save-special-ot.js';
import { removeSpecialOt } from '../src/modules/special-ot/application/remove-special-ot.js';
import { createInitialState } from '../src/seed.js';

test('bulk shift command keeps duplicate, overlap and day-off conflict behavior', () => {
  const state = createInitialState();
  state.shiftTypes.find((type) => type.id === 'evening').startTime = '12:00';
  state.shifts.push({ id: 'old-shift', shiftTypeId: 'morning', workDate: '2026-10-01', startTime: '08:00', endTime: '16:00', urgentOtHours: 0, note: '' });
  state.dayOffs.push({ id: 'old-day-off', workDate: '2026-10-02' });
  const selections = new Map([
    ['morning', new Set(['2026-10-01'])],
    ['evening', new Set(['2026-10-01', '2026-10-02'])],
    ['night', new Set()],
    [DAY_OFF_TYPE, new Set(['2026-10-03'])]
  ]);
  let id = 0;
  const plan = buildBulkPlan(state, selections, () => `new-${++id}`);
  assert.equal(plan.duplicates.length, 1);
  assert.equal(plan.overlaps.length, 1);
  assert.deepEqual(plan.shiftDayOffConflicts, ['2026-10-02']);
  applyBulkPlan(state, plan);
  assert.equal(state.dayOffs.some((item) => item.workDate === '2026-10-02'), false);
  assert.equal(state.specialOtItems.length, 0);
});

test('Special OT command validates, initializes legacy state, updates and removes items', () => {
  const state = createInitialState();
  delete state.specialOtItems;
  const item = createSpecialOtItem({ workDate: '2026-10-10', hours: '2', note: ' เคสด่วน ' }, () => 'special-1');
  assert.deepEqual(item, { id: 'special-1', workDate: '2026-10-10', hours: 2, note: 'เคสด่วน' });
  saveSpecialOt(state, item);
  saveSpecialOt(state, { ...item, hours: 3 });
  assert.deepEqual(state.specialOtItems, [{ ...item, hours: 3 }]);
  removeSpecialOt(state, item.id);
  assert.deepEqual(state.specialOtItems, []);
  assert.throws(() => createSpecialOtItem({ workDate: null, hours: 2 }), /วันที่/);
  assert.throws(() => createSpecialOtItem({ workDate: '2026-10-10', hours: 0 }), /1–24/);
});

test('remove shift and day-off commands do not touch Special OT', () => {
  const state = createInitialState();
  state.shifts = [{ id: 'shift-1' }, { id: 'shift-2' }];
  state.dayOffs = [{ id: 'off-1' }, { id: 'off-2' }];
  state.specialOtItems = [{ id: 'special-1', hours: 2 }];
  removeShift(state, 'shift-1');
  removeDayOff(state, 'off-1');
  assert.deepEqual(state.shifts, [{ id: 'shift-2' }]);
  assert.deepEqual(state.dayOffs, [{ id: 'off-2' }]);
  assert.deepEqual(state.specialOtItems, [{ id: 'special-1', hours: 2 }]);
});
