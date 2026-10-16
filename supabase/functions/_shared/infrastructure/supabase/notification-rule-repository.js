export function createNotificationRuleRepository(supabase) {
  return {
    async list(userId) {
      const { data, error } = await supabase.from('notification_rules').select('id, notification_type, schedule_kind, timezone, schedule_config, enabled, generation, created_at, updated_at').eq('user_id', userId).is('source_shift_id', null).order('created_at');
      if (error) throw error;
      return data ?? [];
    },
    async upsert(userId, rule) {
      const { data, error } = await supabase.rpc('upsert_notification_rule_v2', {
        p_user_id: userId, p_rule_id: rule.id, p_notification_type: rule.notificationType,
        p_schedule_kind: rule.scheduleKind, p_timezone: rule.timezone,
        p_schedule_config: rule.scheduleConfig, p_scheduled_for: rule.scheduledFor.toISOString()
      });
      if (error) throw error;
      return data;
    },
    async cancel(userId, id) {
      const { data, error } = await supabase.rpc('cancel_notification_rule_v2', { p_user_id: userId, p_rule_id: id });
      if (error) throw error;
      return Boolean(data);
    },
    async claimTest(userId) {
      const { data, error } = await supabase.rpc('claim_test_notification', { p_user_id: userId });
      if (error) throw error;
      return Boolean(data);
    }
  };
}
