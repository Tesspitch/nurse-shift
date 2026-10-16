import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calculatePayroll } from '../src/calculations.js';
import { calculateMonthlyHistory } from '../src/history.js';
import { normalizeState } from '../src/service.js';
import { calculateBotMonthSummary } from '../supabase/functions/_shared/line-bot.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const [api, historyRepository, webhook, webhookMigration, fixtureText] = await Promise.all([
  read('../supabase/functions/app-api/index.ts'),
  read('../supabase/functions/_shared/infrastructure/supabase/history-repository.js'),
  read('../supabase/functions/line-webhook/index.ts'),
  read('../supabase/migrations/202610150005_line_webhook_events.sql'),
  read('./fixtures/payroll-golden.json')
]);
const payrollFixture = JSON.parse(fixtureText);

function toBotState(state) {
  return {
    settings: {
      salary: state.settings.salary,
      license_allowance: state.settings.licenseAllowance,
      ot_rate: state.settings.otRate,
      standard_hours: state.settings.standardHours
    },
    shiftTypes: state.shiftTypes.map((item) => ({ id: item.id, name: item.name, premium: item.premium })),
    shifts: state.shifts.map((item) => ({
      shift_type_id: item.shiftTypeId,
      work_date: item.workDate,
      start_time: item.startTime,
      end_time: item.endTime
    })),
    specialOtItems: state.specialOtItems.map((item) => ({ work_date: item.workDate, hours: item.hours })),
    dayOffs: state.dayOffs.map((item) => ({ work_date: item.workDate })),
    financialItems: state.financialItems.map((item) => ({ kind: item.kind, amount: item.amount, work_date: item.workDate }))
  };
}

test('app-api keeps the existing action surface and success envelopes', () => {
  const actions = [...api.matchAll(/if \(action === '([^']+)'\)/g)].map((match) => match[1]);
  assert.deepEqual(actions, [
    'bootstrap',
    'month-history',
    'list-notification-rules',
    'upsert-notification-rule',
    'cancel-notification-rule',
    'replace-state',
    'test-notification',
    'delete-account'
  ]);

  const contracts = {
    bootstrap: /\{ data: await getState\(profile\) \}/,
    'month-history': /\{ data: await getMonthHistory\(profile\.id, String\(payload\.month \|\| ''\)\) \}/,
    'list-notification-rules': /\{ data: data \?\? \[\] \}/,
    'upsert-notification-rule': /\{ data: \{ id, scheduledFor: rule\.scheduledFor\.toISOString\(\), mode: 'shadow' \} \}/,
    'cancel-notification-rule': /\{ data: \{ cancelled: Boolean\(cancelled\) \} \}/,
    'replace-state': /\{ data: \{ version: Number\(version\) \} \}/,
    'test-notification': /\{ data: \{ sent: true \} \}/,
    'delete-account': /\{ data: \{ deleted: true \} \}/
  };
  for (const [action, pattern] of Object.entries(contracts)) {
    assert.match(api, pattern, `${action} response contract changed`);
  }
  assert.match(api, /\{ error: 'UNKNOWN_ACTION' \}, 400/);
});

test('app-api keeps authentication, validation and HTTP error status contracts', () => {
  const expected = new Map([
    ['ORIGIN_NOT_ALLOWED', 403],
    ['STATE_VERSION_CONFLICT', 409],
    ['NOTIFICATION_RATE_LIMITED', 429],
    ['LINE_PUSH_FAILED', 502],
    ['PAYLOAD_TOO_LARGE', 413]
  ]);
  for (const [code, status] of expected) {
    assert.match(api, new RegExp(`message === '${code}'[^\\n]+${status}`));
  }
  assert.match(api, /message\.startsWith\('LINE_'\)[^\n]+401/);
  assert.match(api, /error instanceof SyntaxError \? 'INVALID_JSON' : message[^\n]+400/);
  assert.match(api, /\{ error: 'INTERNAL_ERROR', requestId \}, 500/);
  assert.match(api, /request\.method !== 'POST'[^\n]+METHOD_NOT_ALLOWED[^\n]+405/);
});

test('app-api preserves camelCase state responses and snake_case persistence mapping', () => {
  const mappings = [
    ['licenseAllowance', 'settings.license_allowance'],
    ['otRate', 'settings.ot_rate'],
    ['standardHours', 'settings.standard_hours'],
    ['cycleStartDay', 'settings.cycle_start_day'],
    ['uncertaintyBuffer', 'settings.uncertainty_buffer'],
    ['notificationsEnabled', 'settings.notifications_enabled'],
    ['expirationNotificationsEnabled', 'settings.expiration_notifications_enabled'],
    ['shiftTypeId', 'shift.shift_type_id'],
    ['workDate', 'shift.work_date'],
    ['startTime', 'shift.start_time'],
    ['endTime', 'shift.end_time'],
    ['offsetMinutes', 'reminder.offset_minutes']
  ];
  for (const [clientKey, databaseExpression] of mappings) {
    assert.match(`${api}\n${historyRepository}`, new RegExp(`${clientKey}: (?:Number\\()?${databaseExpression.replaceAll('.', '\\.')}`));
  }
  assert.match(api, /replace_user_state_v2/);
  assert.match(api, /p_expected_version: Number\(payload\.version\)/);
});

test('golden payroll behavior matches current payroll, history and LINE bot paths', () => {
  const { state, expected } = payrollFixture;
  const payroll = calculatePayroll(structuredClone(state), new Date(payrollFixture.anchorDate));
  const history = calculateMonthlyHistory(structuredClone(state), '2026-10');
  const bot = calculateBotMonthSummary(toBotState(state));

  for (const result of [payroll, history]) {
    assert.equal(result.workedHours, expected.workedHours);
    assert.equal(result.automaticOtHours ?? result.normalOtHours, expected.normalOtHours);
    assert.equal(result.specialOtHours, expected.specialOtHours);
    assert.equal(result.shiftPremium ?? result.shiftIncome, expected.shiftPremium);
    assert.equal(result.otherIncome, expected.otherIncome);
    assert.equal(result.deductions, expected.deductions);
    assert.equal(result.otIncome ?? (result.normalOtIncome + result.specialOtIncome), expected.otIncome);
    assert.equal(result.gross, expected.gross);
    assert.equal(result.net, expected.net);
  }
  assert.equal(payroll.estimateLow, expected.estimateLow);
  assert.equal(payroll.estimateHigh, expected.estimateHigh);
  assert.equal(history.dayOffs.length, expected.dayOffCount);
  assert.deepEqual(history.shiftCounts, expected.shiftCounts);

  assert.equal(bot.workedHours, expected.workedHours);
  assert.equal(bot.normalOtHours, expected.normalOtHours);
  assert.equal(bot.specialOtHours, expected.specialOtHours);
  assert.equal(bot.shiftIncome, expected.shiftPremium);
  assert.equal(bot.otIncome, expected.otIncome);
  assert.equal(bot.gross, expected.gross);
  assert.equal(bot.net, expected.net);
  assert.equal(bot.dayOffCount, expected.dayOffCount);
  assert.deepEqual(bot.shiftCounts, expected.shiftCounts);
});

test('legacy state normalization remains compatible without changing persisted records', () => {
  const legacy = structuredClone(payrollFixture.state);
  legacy.shifts[0].urgentOtHours = 3;
  delete legacy.specialOtItems;
  delete legacy.dayOffs;
  delete legacy.settings.expirationNotificationsEnabled;
  const normalized = normalizeState(legacy);

  assert.equal(normalized.specialOtItems.length, 1);
  assert.equal(normalized.specialOtItems[0].hours, 3);
  assert.equal(normalized.shifts[0].urgentOtHours, 0);
  assert.deepEqual(normalized.dayOffs, []);
  assert.equal(normalized.settings.expirationNotificationsEnabled, true);
});

test('LINE webhook claims events before side effects and ignores duplicate claims', () => {
  const processBlock = webhook.slice(webhook.indexOf('async function processEvent'), webhook.indexOf('Deno.serve'));
  assert.match(processBlock, /!\(await claimEvent\(eventId\)\)\) return/);
  assert.ok(processBlock.indexOf('claimEvent(eventId)') < processBlock.indexOf('linkRichMenu('));
  assert.ok(processBlock.indexOf('claimEvent(eventId)') < processBlock.indexOf('await reply('));
  assert.match(webhookMigration, /on conflict \(event_id\) do update/);
  assert.match(webhookMigration, /status = 'failed'/);
  assert.match(webhookMigration, /attempts < 5/);
});

test('LINE webhook preserves privacy and unlinked-user responses', () => {
  assert.match(webhook, /ข้อมูลรายได้เป็นข้อมูลส่วนตัว/);
  assert.match(webhook, /ยังไม่พบบัญชี NurseShift กรุณาเปิดแอปและตั้งค่าให้เรียบร้อยก่อน/);
  assert.match(webhook, /label: 'เปิด NurseShift', uri: liffUrl/);
  assert.match(webhook, /event\.source\?\.userId/);
  assert.match(webhook, /if \(!lineUserId\)[\s\S]+completeEvent\(eventId, 'completed'\)/);
});

test('frontend form actions remain connected to one commit path', async () => {
  const app = await read('../src/app.js');
  const html = await read('../index.html');
  for (const action of ['open-shift', 'open-special-ot']) {
    assert.match(app, new RegExp(`data-action=["']${action}["']`), `${action} is no longer wired`);
  }
  assert.match(app, /#bulk-save'\)\.addEventListener\('click'/);
  for (const formId of ['special-ot-form', 'finance-form', 'settings-form']) {
    assert.match(app, new RegExp(`#${formId.replaceAll('-', '\\-')}'\\)\\.addEventListener\\('submit'`));
    assert.match(html, new RegExp(`id=["']${formId}["']`));
  }
  assert.match(app, /async function commit\(/);
  assert.match(app, /if \(commitInProgress\)/);
  assert.match(app, /state = await dataService\.save\(state\)/);
});
