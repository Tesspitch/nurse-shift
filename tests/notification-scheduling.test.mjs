import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canProcessJob,
  classifyLineResponse,
  isValidTimeZone,
  nextRunAt,
  notificationIdempotencyKey,
  retryDelayMs,
  validateNotificationRule
} from '../supabase/functions/_shared/notification-scheduling.js';

const bangkok = { timezone: 'Asia/Bangkok' };

test('validates supported schedule kinds and rejects invalid inputs', () => {
  assert.equal(validateNotificationRule({ ...bangkok, scheduleKind: 'daily', scheduleConfig: { time: '07:30' } }), true);
  assert.throws(() => validateNotificationRule({ ...bangkok, scheduleKind: 'weekly', scheduleConfig: { time: '07:30', weekday: 7 } }));
  assert.equal(isValidTimeZone('Asia/Bangkok'), true);
  assert.equal(isValidTimeZone('Not/A_Zone'), false);
});

test('one-time schedules run once and then expire', () => {
  const rule = { ...bangkok, scheduleKind: 'one_time', scheduleConfig: { at: '2026-10-20T01:00:00.000Z' } };
  assert.equal(nextRunAt(rule, '2026-10-19T00:00:00.000Z').toISOString(), '2026-10-20T01:00:00.000Z');
  assert.equal(nextRunAt(rule, '2026-10-21T00:00:00.000Z'), null);
});

test('daily recurrence respects Bangkok local time', () => {
  const result = nextRunAt({ ...bangkok, scheduleKind: 'daily', scheduleConfig: { time: '08:00' } }, '2026-10-15T00:30:00.000Z');
  assert.equal(result.toISOString(), '2026-10-15T01:00:00.000Z');
});

test('weekly recurrence uses local weekday', () => {
  const result = nextRunAt({ ...bangkok, scheduleKind: 'weekly', scheduleConfig: { weekday: 1, time: '09:00' } }, '2026-10-18T12:00:00.000Z');
  assert.equal(result.toISOString(), '2026-10-19T02:00:00.000Z');
});

test('monthly recurrence clamps missing days to month end', () => {
  const result = nextRunAt({ ...bangkok, scheduleKind: 'monthly', scheduleConfig: { day: 31, time: '08:00' } }, '2027-02-01T00:00:00.000Z');
  assert.equal(result.toISOString(), '2027-02-28T01:00:00.000Z');
});

test('timezone conversion handles DST gaps without inventing a local instant', () => {
  const result = nextRunAt({ timezone: 'America/New_York', scheduleKind: 'daily', scheduleConfig: { time: '02:30' } }, '2027-03-14T05:00:00.000Z');
  assert.equal(result.toISOString(), '2027-03-15T06:30:00.000Z');
});

test('idempotency key is stable for the same generation and instant', () => {
  assert.equal(notificationIdempotencyKey('rule-1', 3, '2026-10-15T01:00:00Z'), 'rule-1:3:2026-10-15T01:00:00.000Z');
});

test('LINE response policy accepts retry-key conflicts and retries only transient failures', () => {
  assert.equal(classifyLineResponse(200).outcome, 'accepted');
  assert.equal(classifyLineResponse(409, 'accepted-request').outcome, 'accepted_duplicate');
  assert.equal(classifyLineResponse(429).outcome, 'retry');
  assert.equal(classifyLineResponse(503).outcome, 'retry');
  assert.equal(classifyLineResponse(400).outcome, 'permanent_failure');
});

test('retry delay uses bounded exponential policy and jitter', () => {
  assert.equal(retryDelayMs(1, 0), 60_000);
  assert.equal(retryDelayMs(2, 1), 330_000);
  assert.equal(retryDelayMs(5), null);
});

test('stale, cancelled and generation-mismatched callbacks cannot process jobs', () => {
  const job = { status: 'pending', generation: 2, ruleGeneration: 2, ruleEnabled: true };
  assert.equal(canProcessJob(job, 2), true);
  assert.equal(canProcessJob({ ...job, status: 'cancelled' }, 2), false);
  assert.equal(canProcessJob({ ...job, ruleEnabled: false }, 2), false);
  assert.equal(canProcessJob(job, 1), false);
});
