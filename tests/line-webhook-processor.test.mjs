import test from 'node:test';
import assert from 'node:assert/strict';
import { createLineWebhookProcessor } from '../supabase/functions/_shared/application/line-webhook-processor.js';

const liffUrl = 'https://liff.line.me/test';

function createHarness(overrides = {}) {
  const calls = [];
  const eventRepository = {
    async claim(eventId) {
      calls.push(['claim', eventId]);
      return true;
    },
    async complete(...args) {
      calls.push(['complete', ...args]);
    },
    ...overrides.eventRepository
  };
  const userDataRepository = {
    async getProfile(lineUserId) {
      calls.push(['profile', lineUserId]);
      return { id: 'user-1' };
    },
    async getMonthData(userId) {
      calls.push(['month', userId]);
      return {
        range: { monthKey: '2026-10', start: '2026-10-01', end: '2026-10-31' },
        settings: { salary: 20000, license_allowance: 2000, ot_rate: 100, standard_hours: 176 },
        shiftTypes: [{ id: 'morning', name: 'เวรเช้า', premium: 0 }],
        shifts: [{ shift_type_id: 'morning', work_date: '2026-10-01', start_time: '08:00', end_time: '16:00' }],
        specialOtItems: [],
        dayOffs: [],
        financialItems: []
      };
    },
    async getNextShift(userId) {
      calls.push(['next-shift', userId]);
      return { work_date: '2026-10-17', start_time: '08:00:00', end_time: '16:00:00', shift_name: 'เวรเช้า' };
    },
    ...overrides.userDataRepository
  };
  const messagingGateway = {
    async reply(...args) {
      calls.push(['reply', ...args]);
    },
    async linkRichMenu(...args) {
      calls.push(['link', ...args]);
    },
    ...overrides.messagingGateway
  };
  const processor = createLineWebhookProcessor({
    webhookEventRepository: eventRepository,
    lineUserDataRepository: userDataRepository,
    lineMessagingGateway: messagingGateway,
    liffUrl,
    richMenuPage2Id: 'rich-menu-page-2',
    now: () => new Date('2026-10-15T12:00:00+07:00')
  });
  return { calls, processor };
}

function event(overrides = {}) {
  return {
    webhookEventId: 'event-1',
    replyToken: 'reply-token',
    type: 'postback',
    source: { type: 'user', userId: 'line-user-1' },
    postback: { data: 'action=help' },
    ...overrides
  };
}

test('does not process duplicate or incomplete events', async () => {
  const duplicate = createHarness({ eventRepository: { async claim() { return false; } } });
  await duplicate.processor.processEvent(event());
  assert.deepEqual(duplicate.calls, []);

  const incomplete = createHarness();
  await incomplete.processor.processEvent(event({ replyToken: '' }));
  assert.deepEqual(incomplete.calls, []);
});

test('completes events without a LINE user id without side effects', async () => {
  const { calls, processor } = createHarness();
  await processor.processEvent(event({ source: { type: 'user' } }));
  assert.deepEqual(calls, [['claim', 'event-1'], ['complete', 'event-1', 'completed']]);
});

test('links the quick-info rich menu before replying to the exact trigger message', async () => {
  const { calls, processor } = createHarness();
  await processor.processEvent(event({
    type: 'message',
    message: { type: 'text', text: ' เมนูเพิ่มเติม ' }
  }));
  assert.deepEqual(calls.map(([name]) => name), ['claim', 'link', 'reply', 'complete']);
  assert.deepEqual(calls[1], ['link', 'line-user-1', 'rich-menu-page-2']);
  assert.deepEqual(calls[2], ['reply', 'reply-token', [{
    type: 'text',
    text: 'เปิดเมนูข้อมูลด่วนแล้ว แตะเมนูด้านล่างเพื่อใช้งานได้เลย'
  }]]);
});

test('keeps salary details private in group chats', async () => {
  const { calls, processor } = createHarness();
  await processor.processEvent(event({
    postback: { data: 'action=monthly_income' },
    source: { type: 'group', userId: 'line-user-1' }
  }));
  const reply = calls.find(([name]) => name === 'reply');
  assert.equal(reply[2][0].text, 'ข้อมูลรายได้เป็นข้อมูลส่วนตัว กรุณาเปิดแชตส่วนตัวกับ NurseShift');
  assert.equal(calls.some(([name]) => name === 'month'), false);
  assert.deepEqual(calls.at(-1), ['complete', 'event-1', 'completed']);
});

test('returns the existing quick reply for users without a linked profile', async () => {
  const { calls, processor } = createHarness({
    userDataRepository: { async getProfile() { return null; } }
  });
  await processor.processEvent(event({ postback: { data: 'action=monthly_shifts' } }));
  const message = calls.find(([name]) => name === 'reply')[2][0];
  assert.equal(message.text, 'ยังไม่พบบัญชี NurseShift กรุณาเปิดแอปและตั้งค่าให้เรียบร้อยก่อน');
  assert.equal(message.quickReply.items[0].action.uri, liffUrl);
});

test('builds monthly summaries from the authorized user repository data', async () => {
  const { calls, processor } = createHarness();
  await processor.processEvent(event({ postback: { data: 'action=monthly_shifts' } }));
  const message = calls.find(([name]) => name === 'reply')[2][0];
  assert.equal(message.type, 'flex');
  assert.equal(message.altText, 'สรุปเวร ตุลาคม 2569');
  assert.equal(calls.some(([name, userId]) => name === 'month' && userId === 'user-1'), true);
});

test('records processing failures and rethrows them to the HTTP controller', async () => {
  const { calls, processor } = createHarness({
    messagingGateway: {
      async reply() { throw new Error('LINE_REPLY_FAILED_500'); }
    }
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      processor.processEvent(event()),
      { message: 'LINE_REPLY_FAILED_500' }
    );
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(calls.at(-1), ['complete', 'event-1', 'failed', 'LINE_REPLY_FAILED_500']);
});
