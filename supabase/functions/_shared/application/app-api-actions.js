import { nextRunAt, validateNotificationRule } from '../notification-scheduling.js';
import { validateState } from '../domain/user-state-validation.js';

function validatedNotificationRule(payload) {
  const scheduleKind = String(payload.scheduleKind || '');
  const timezone = String(payload.timezone || 'Asia/Bangkok');
  const scheduleConfig = payload.scheduleConfig;
  const notificationType = String(payload.notificationType || 'custom');
  if (!['custom', 'ot_reminder'].includes(notificationType) || !scheduleConfig || typeof scheduleConfig !== 'object') throw new Error('INVALID_NOTIFICATION_RULE');
  if (String(scheduleConfig.payload?.message || '').length > 500) throw new Error('INVALID_NOTIFICATION_RULE');
  const rule = { scheduleKind, timezone, scheduleConfig };
  validateNotificationRule(rule);
  const scheduledFor = nextRunAt(rule, new Date());
  if (!scheduledFor) throw new Error('INVALID_NOTIFICATION_RULE');
  const id = payload.id == null || payload.id === '' ? null : String(payload.id);
  if (id && !/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error('INVALID_NOTIFICATION_RULE');
  return { id, notificationType, scheduleKind, timezone, scheduleConfig, scheduledFor };
}

export function createAppApiActions({ userStateRepository, historyUseCase, notificationRuleRepository, linePushGateway }) {
  return async function handleAction({ action, payload, profile, lineUser }) {
    if (action === 'bootstrap') return userStateRepository.getState(profile);
    if (action === 'month-history') return historyUseCase(profile.id, String(payload.month || ''));
    if (action === 'list-notification-rules') return notificationRuleRepository.list(profile.id);
    if (action === 'upsert-notification-rule') {
      const rule = validatedNotificationRule(payload);
      const id = await notificationRuleRepository.upsert(profile.id, rule);
      return { id, scheduledFor: rule.scheduledFor.toISOString(), mode: 'shadow' };
    }
    if (action === 'cancel-notification-rule') {
      const id = String(payload.id || '');
      if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error('INVALID_NOTIFICATION_RULE');
      return { cancelled: await notificationRuleRepository.cancel(profile.id, id) };
    }
    if (action === 'replace-state') {
      validateState(payload);
      return { version: await userStateRepository.replace(profile.id, payload) };
    }
    if (action === 'test-notification') {
      if (!(await notificationRuleRepository.claimTest(profile.id))) throw new Error('NOTIFICATION_RATE_LIMITED');
      await linePushGateway.sendTest(lineUser.sub);
      return { sent: true };
    }
    if (action === 'delete-account') {
      await userStateRepository.delete(profile, lineUser.sub);
      return { deleted: true };
    }
    const error = new Error('UNKNOWN_ACTION');
    error.status = 400;
    throw error;
  };
}
