import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  BOT_ACTIONS,
  calculateBotMonthSummary,
  canShowActionInSource,
  createFlexMessage,
  parsePostbackAction,
  verifyLineSignature
} from '../supabase/functions/_shared/line-bot.js';

test('accepts only the six supported LINE postback actions', () => {
  assert.equal(parsePostbackAction('action=next_shift'), 'next_shift');
  assert.equal(parsePostbackAction('action=monthly_income&source=menu'), 'monthly_income');
  assert.equal(parsePostbackAction('action=unknown'), null);
  assert.equal(BOT_ACTIONS.size, 6);
});

test('verifies LINE signature against the unmodified raw body', async () => {
  const body = '{"events":[{"type":"postback"}]}';
  const secret = 'phase-4-test-secret';
  const signature = createHmac('sha256', secret).update(body).digest('base64');
  assert.equal(await verifyLineSignature(body, signature, secret), true);
  assert.equal(await verifyLineSignature(`${body} `, signature, secret), false);
  assert.equal(await verifyLineSignature(body, '', secret), false);
});

test('bot summary matches the monthly LIFF rules and does not double-count overlaps', () => {
  const summary = calculateBotMonthSummary({
    settings: { salary: 20000, license_allowance: 2000, ot_rate: 100, standard_hours: 8 },
    shiftTypes: [{ id: 'morning', name: 'เวรเช้า', premium: 0 }, { id: 'evening', name: 'เวรบ่าย', premium: 200 }],
    shifts: [
      { shift_type_id: 'morning', work_date: '2026-10-01', start_time: '08:00', end_time: '16:00' },
      { shift_type_id: 'evening', work_date: '2026-10-01', start_time: '12:00', end_time: '20:00' }
    ],
    specialOtItems: [{ work_date: '2026-10-01', hours: 2 }],
    dayOffs: [{ work_date: '2026-10-02' }],
    financialItems: [{ kind: 'income', amount: 500 }, { kind: 'deduction', amount: 300 }]
  });
  assert.equal(summary.workedHours, 12);
  assert.equal(summary.normalOtHours, 4);
  assert.equal(summary.specialOtHours, 2);
  assert.equal(summary.totalOtHours, 6);
  assert.equal(summary.shiftIncome, 200);
  assert.equal(summary.net, 23000);
  assert.equal(summary.dayOffCount, 1);
});

test('salary details are restricted to a one-to-one chat', () => {
  assert.equal(canShowActionInSource('monthly_income', 'user'), true);
  assert.equal(canShowActionInSource('monthly_income', 'group'), false);
  assert.equal(canShowActionInSource('ot_summary', 'group'), true);
});

test('all actions create valid Flex bubbles with LIFF actions', () => {
  const base = {
    monthLabel: 'ตุลาคม 2569',
    summary: { gross: 20000, net: 19500, shiftIncome: 200, normalOtIncome: 100, specialOtIncome: 100, workedHours: 177, normalOtHours: 1, specialOtHours: 1, totalOtHours: 2, otIncome: 200, shiftCounts: { morning: 1 }, dayOffCount: 1 },
    shiftTypes: [{ id: 'morning', name: 'เวรเช้า' }],
    dayOffs: [{ work_date: '2026-10-02' }],
    shift: { work_date: '2026-10-03', shift_name: 'เวรเช้า', start_time: '08:00', end_time: '16:00' }
  };
  for (const action of BOT_ACTIONS) {
    const message = createFlexMessage(action, base, 'https://liff.line.me/test');
    assert.equal(message.type, 'flex');
    assert.equal(message.contents.type, 'bubble');
    assert.match(message.contents.footer.contents[0].action.uri, /^https:\/\/liff\.line\.me\/test\?screen=/);
    assert.ok(message.altText.length <= 400);
  }
});

test('page configs contain reciprocal switches and page 2 contains six postbacks', async () => {
  const page1 = JSON.parse(await readFile(new URL('../docs/line-rich-menu.json', import.meta.url)));
  const page2 = JSON.parse(await readFile(new URL('../docs/line-rich-menu-page-2.json', import.meta.url)));
  assert.equal(page1.areas.length, 5);
  assert.equal(page1.areas.filter((area) => area.action.type === 'richmenuswitch').length, 1);
  assert.equal(page1.areas.find((area) => area.action.type === 'richmenuswitch').action.richMenuAliasId, 'nurseshift-quick-info');
  assert.equal(page2.name, 'NurseShift Quick Info');
  assert.equal(page2.areas.filter((area) => area.action.type === 'postback').length, 6);
  assert.equal(page2.areas.filter((area) => area.action.type === 'richmenuswitch').length, 1);
  assert.deepEqual(new Set(page2.areas.filter((area) => area.action.type === 'postback').map((area) => parsePostbackAction(area.action.data))), BOT_ACTIONS);
});
