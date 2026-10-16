export function createWebhookEventRepository(supabase, { now = () => new Date() } = {}) {
  return {
    async claim(eventId) {
      const { data, error } = await supabase.rpc('claim_line_webhook_event', { p_event_id: eventId });
      if (error) throw error;
      return Boolean(data);
    },

    async complete(eventId, status, errorMessage = null) {
      const { error } = await supabase.from('line_webhook_events')
        .update({ status, completed_at: now().toISOString(), last_error: errorMessage })
        .eq('event_id', eventId);
      if (error) throw error;
    }
  };
}
