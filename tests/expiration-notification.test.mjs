import test from 'node:test';
import assert from 'node:assert/strict';
import { createExpirationMessage, expirationPlan } from '../supabase/functions/_shared/expiration-notification.js';

test('October shows August through October and schedules August expiry notices', () => {
  const plan = expirationPlan('2026-10-15T05:00:00.000Z');
  assert.deepEqual(plan.allowedMonths, ['2026-08', '2026-09', '2026-10']);
  assert.equal(plan.expiringMonth, '2026-08');
  assert.equal(plan.expiryDate, '2026-10-31T17:00:00.000Z');
  assert.deepEqual(plan.notices.map((item) => [item.daysBefore, item.scheduledFor.toISOString()]), [
    [7, '2026-10-25T02:00:00.000Z'], [3, '2026-10-29T02:00:00.000Z'], [1, '2026-10-31T02:00:00.000Z']
  ]);
});

test('November crosses the display window to September through November', () => {
  const plan = expirationPlan('2026-11-15T05:00:00.000Z');
  assert.deepEqual(plan.allowedMonths, ['2026-09', '2026-10', '2026-11']);
  assert.equal(plan.expiringMonth, '2026-09');
});

test('expiration planning handles year rollover and February', () => {
  const year = expirationPlan('2027-01-15T05:00:00.000Z');
  assert.deepEqual(year.allowedMonths, ['2026-11', '2026-12', '2027-01']);
  assert.equal(year.expiringMonth, '2026-11');
  const february = expirationPlan('2027-02-15T05:00:00.000Z');
  assert.equal(february.expiringMonth, '2026-12');
  assert.equal(february.expiryDate, '2027-02-28T17:00:00.000Z');
});

test('Thai templates avoid salary details and deletion claims', () => {
  const message = createExpirationMessage({
    expiringMonth: '2026-08', expiryDate: '2026-10-31T17:00:00.000Z', daysBefore: 7,
    liffUrl: 'https://liff.line.me/example'
  });
  assert.match(message, /สิงหาคม 2569/);
  assert.match(message, /อีก 7 วัน/);
  assert.match(message, /เปิด NurseShift/);
  assert.doesNotMatch(message, /เงินเดือน|ลบข้อมูล/);
});
