import test from 'node:test';
import assert from 'node:assert/strict';
import { sendLinePush } from '../supabase/functions/_shared/line-delivery.js';
import { createSchedulerAdapter, signSchedulerBody, verifySchedulerInvocation } from '../supabase/functions/_shared/scheduler-adapter.js';

function response(status, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: new Headers(headers), async json() { return {}; } };
}

test('LINE delivery keeps the supplied retry key and accepts a successful push', async () => {
  let request;
  const result = await sendLinePush({
    to: 'U-test', messages: [{ type: 'text', text: 'test' }], retryKey: '00000000-0000-4000-8000-000000000001',
    channelAccessToken: 'token',
    fetchImpl: async (_url, options) => { request = options; return response(200, { 'x-line-request-id': 'request-1' }); }
  });
  assert.equal(request.headers['X-Line-Retry-Key'], '00000000-0000-4000-8000-000000000001');
  assert.equal(result.outcome, 'accepted');
  assert.equal(result.requestId, 'request-1');
});

test('LINE timeout is retryable and permanent 4xx is not', async () => {
  const timeout = await sendLinePush({
    to: 'U-test', messages: [{ type: 'text', text: 'test' }], retryKey: crypto.randomUUID(), channelAccessToken: 'token',
    fetchImpl: async () => { const error = new Error('timeout'); error.name = 'AbortError'; throw error; }
  });
  const invalid = await sendLinePush({
    to: 'U-test', messages: [{ type: 'text', text: 'test' }], retryKey: crypto.randomUUID(), channelAccessToken: 'token',
    fetchImpl: async () => response(400)
  });
  assert.equal(timeout.outcome, 'retry');
  assert.equal(timeout.errorCode, 'LINE_TIMEOUT');
  assert.equal(invalid.outcome, 'permanent_failure');
});

test('LINE retry-key conflict is accepted only with the original accepted request id', async () => {
  const accepted = await sendLinePush({
    to: 'U-test', messages: [{ type: 'text', text: 'test' }], retryKey: crypto.randomUUID(), channelAccessToken: 'token',
    fetchImpl: async () => response(409, { 'x-line-accepted-request-id': 'accepted-1' })
  });
  const unknown = await sendLinePush({
    to: 'U-test', messages: [{ type: 'text', text: 'test' }], retryKey: crypto.randomUUID(), channelAccessToken: 'token',
    fetchImpl: async () => response(409, { 'x-line-request-id': 'conflict-1' })
  });
  assert.equal(accepted.outcome, 'accepted_duplicate');
  assert.equal(unknown.outcome, 'permanent_failure');
});

test('scheduler signatures reject unauthorized and stale callbacks', async () => {
  const body = '{"jobId":"job-1"}';
  const timestamp = '1792036800';
  const secret = 'test-secret';
  const signature = await signSchedulerBody(body, timestamp, secret);
  assert.equal(await verifySchedulerInvocation({ body, timestamp, signature, secret, now: 1792036800_000 }), true);
  assert.equal(await verifySchedulerInvocation({ body: `${body} `, timestamp, signature, secret, now: 1792036800_000 }), false);
  assert.equal(await verifySchedulerInvocation({ body, timestamp, signature, secret, now: 1792037401_000 }), false);
});

test('database scheduler is idempotent infrastructure and external failure is surfaced', async () => {
  const database = createSchedulerAdapter();
  assert.deepEqual(await database.register({ id: 'job-1' }), { provider: 'database', reference: 'database:job-1' });
  const external = createSchedulerAdapter({
    provider: 'external', endpoint: 'https://scheduler.invalid/jobs', token: 'token',
    fetchImpl: async () => response(503)
  });
  await assert.rejects(() => external.register({ id: 'job-1', generation: 1, scheduledFor: new Date().toISOString() }), /SCHEDULER_REGISTRATION_FAILED/);
});
