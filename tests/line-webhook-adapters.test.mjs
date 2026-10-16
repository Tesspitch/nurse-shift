import test from 'node:test';
import assert from 'node:assert/strict';
import { createLineMessagingGateway } from '../supabase/functions/_shared/infrastructure/line/line-messaging-gateway.js';
import { createLineUserDataRepository } from '../supabase/functions/_shared/infrastructure/supabase/line-user-data-repository.js';
import { createWebhookEventRepository } from '../supabase/functions/_shared/infrastructure/supabase/webhook-event-repository.js';

function createQueryBuilder(table, result, calls) {
  const builder = {
    select(columns) {
      calls.push([table, 'select', columns]);
      return builder;
    },
    update(values) {
      calls.push([table, 'update', values]);
      return builder;
    },
    eq(column, value) {
      calls.push([table, 'eq', column, value]);
      return builder;
    },
    gte(column, value) {
      calls.push([table, 'gte', column, value]);
      return builder;
    },
    lte(column, value) {
      calls.push([table, 'lte', column, value]);
      return builder;
    },
    order(column) {
      calls.push([table, 'order', column]);
      return builder;
    },
    limit(value) {
      calls.push([table, 'limit', value]);
      return builder;
    },
    single() {
      return Promise.resolve(result);
    },
    maybeSingle() {
      return Promise.resolve(result);
    },
    then(resolve, reject) {
      return Promise.resolve(result).then(resolve, reject);
    }
  };
  return builder;
}

test('webhook event repository uses the existing claim RPC and records completion time', async () => {
  const calls = [];
  const supabase = {
    rpc: async (...args) => {
      calls.push(['rpc', ...args]);
      return { data: true, error: null };
    },
    from(table) {
      return createQueryBuilder(table, { data: null, error: null }, calls);
    }
  };
  const repository = createWebhookEventRepository(supabase, {
    now: () => new Date('2026-10-16T00:00:00.000Z')
  });

  assert.equal(await repository.claim('event-1'), true);
  await repository.complete('event-1', 'failed', 'delivery failed');
  assert.deepEqual(calls[0], ['rpc', 'claim_line_webhook_event', { p_event_id: 'event-1' }]);
  assert.ok(calls.some((call) => call[0] === 'line_webhook_events'
    && call[1] === 'update'
    && call[2].status === 'failed'
    && call[2].last_error === 'delivery failed'
    && call[2].completed_at === '2026-10-16T00:00:00.000Z'));
  assert.ok(calls.some((call) => call[0] === 'line_webhook_events'
    && call[1] === 'eq'
    && call[2] === 'event_id'
    && call[3] === 'event-1'));
});

test('LINE user repository scopes month and next-shift queries to the linked profile', async () => {
  const calls = [];
  const tableResults = {
    profiles: { data: { id: 'profile-1' }, error: null },
    user_settings: { data: { salary: 20000 }, error: null },
    shift_types: { data: [], error: null },
    shifts: { data: [], error: null },
    special_ot_items: { data: [], error: null },
    day_offs: { data: [], error: null },
    financial_items: { data: [], error: null }
  };
  const supabase = {
    from(table) {
      return createQueryBuilder(table, tableResults[table], calls);
    }
  };
  const repository = createLineUserDataRepository(supabase, {
    now: () => new Date('2026-10-16T02:00:00.000Z')
  });

  assert.deepEqual(await repository.getProfile('line-user-1'), { id: 'profile-1' });
  const month = await repository.getMonthData('profile-1');
  assert.deepEqual(month.range, { monthKey: '2026-10', start: '2026-10-01', end: '2026-10-31' });
  assert.deepEqual(month.shiftTypes, []);
  assert.equal(await repository.getNextShift('profile-1'), null);
  for (const table of ['user_settings', 'shift_types', 'shifts', 'special_ot_items', 'day_offs', 'financial_items']) {
    assert.ok(calls.some((call) => call[0] === table && call[1] === 'eq' && call[2] === 'user_id' && call[3] === 'profile-1'), `${table} query is not scoped to the profile`);
  }
});

test('LINE messaging gateway preserves endpoint, payload and failure contracts', async () => {
  const requests = [];
  const gateway = createLineMessagingGateway({
    channelAccessToken: 'channel-token',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200 };
    }
  });
  const messages = [{ type: 'text', text: 'test' }];
  await gateway.reply('reply-1', messages);
  await gateway.linkRichMenu('line/user', 'menu id');

  assert.equal(requests[0].url, 'https://api.line.me/v2/bot/message/reply');
  assert.deepEqual(JSON.parse(requests[0].options.body), { replyToken: 'reply-1', messages });
  assert.equal(requests[0].options.headers.Authorization, 'Bearer channel-token');
  assert.equal(requests[1].url, 'https://api.line.me/v2/bot/user/line%2Fuser/richmenu/menu%20id');
  assert.equal(requests[1].options.body, undefined);

  const failingGateway = createLineMessagingGateway({
    channelAccessToken: 'channel-token',
    fetchImpl: async () => ({ ok: false, status: 429 })
  });
  await assert.rejects(failingGateway.reply('reply-1', messages), /LINE_REPLY_FAILED_429/);
  await assert.rejects(failingGateway.linkRichMenu('user', 'menu'), /LINE_RICH_MENU_LINK_FAILED_429/);
});
