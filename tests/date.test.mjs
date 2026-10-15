import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDateInput, getCycleRange, parseDateInput } from '../src/date.js';

test('parses Buddhist Era dd/mm/yyyy and rejects invalid leap dates', () => {
  assert.equal(parseDateInput('29/02/2567'), '2024-02-29');
  assert.equal(parseDateInput('29/02/2568'), null);
  assert.equal(formatDateInput('2026-10-15'), '15/10/2569');
});

test('calculates a 25-to-24 payroll cycle across month and year boundaries', () => {
  assert.deepEqual(getCycleRange(new Date(2026, 0, 10), 25), { start: '2025-12-25', end: '2026-01-24' });
  assert.deepEqual(getCycleRange(new Date(2026, 1, 25), 25), { start: '2026-02-25', end: '2026-03-24' });
});
