import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppApiActions } from '../supabase/functions/_shared/application/app-api-actions.js';
import { validateState } from '../supabase/functions/_shared/domain/user-state-validation.js';
import { createLineIdentityGateway } from '../supabase/functions/_shared/infrastructure/line/line-identity-gateway.js';
import { createInitialState } from '../src/seed.js';

test('state validator preserves version, conflict and Special OT invariants', () => {
  const state = createInitialState();
  assert.doesNotThrow(() => validateState(state));
  assert.throws(() => validateState({ ...state, version: -1 }), /INVALID_STATE/);
  assert.throws(() => validateState({ ...state, specialOtItems: [{ id: crypto.randomUUID(), workDate: '2026-10-01', hours: 0, note: '' }] }), /INVALID_SPECIAL_OT_ITEM/);
  assert.throws(() => validateState({ ...state, shifts: [{ id: crypto.randomUUID(), shiftTypeId: 'morning', workDate: '2026-10-01', startTime: '08:00', endTime: '16:00', urgentOtHours: 0, note: '' }], dayOffs: [{ id: crypto.randomUUID(), workDate: '2026-10-01' }] }), /INVALID_DAY_OFF_CONFLICT/);
});

test('LINE identity gateway keeps token verification request contract', async () => {
  let request;
  const gateway = createLineIdentityGateway({
    channelId: 'channel-1',
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, async json() { return { sub: 'U1', name: 'Nurse' }; } }; }
  });
  const result = await gateway.authenticate(new Request('https://example.test', { headers: { 'x-line-id-token': 'token-1' } }));
  assert.equal(result.sub, 'U1');
  assert.equal(request.url, 'https://api.line.me/oauth2/v2.1/verify');
  assert.equal(request.options.body.get('client_id'), 'channel-1');
  assert.equal(request.options.body.get('id_token'), 'token-1');
});

test('app-api actions preserve response data without depending on HTTP or Supabase', async () => {
  const calls = [];
  const handle = createAppApiActions({
    userStateRepository: {
      async getState() { return { version: 2 }; },
      async replace(_id, state) { calls.push('replace'); return state.version + 1; },
      async delete() { calls.push('delete'); }
    },
    historyUseCase: async () => ({ shifts: [] }),
    notificationRuleRepository: { async list() { return []; }, async claimTest() { return true; } },
    linePushGateway: { async sendTest() { calls.push('push'); } }
  });
  const context = { profile: { id: 'profile-1' }, lineUser: { sub: 'U1' }, payload: {} };
  assert.deepEqual(await handle({ ...context, action: 'bootstrap' }), { version: 2 });
  assert.deepEqual(await handle({ ...context, action: 'test-notification' }), { sent: true });
  assert.deepEqual(await handle({ ...context, action: 'delete-account' }), { deleted: true });
  await assert.rejects(() => handle({ ...context, action: 'unknown' }), /UNKNOWN_ACTION/);
  assert.deepEqual(calls, ['push', 'delete']);
});
