export function createFeedbackRepository(supabase) {
  return {
    async create(userId, payload) {
      const { data, error } = await supabase
        .from('feedback')
        .insert({ user_id: userId, category: payload.category, message: payload.message })
        .select('id, category, message, status, created_at')
        .single();
      if (error) throw error;
      return data;
    },
    async list() {
      const { data, error } = await supabase
        .from('feedback')
        .select('id, user_id, category, message, status, admin_note, created_at, updated_at, profiles(display_name, picture_url)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    async update(id, payload) {
      const { data, error } = await supabase
        .from('feedback')
        .update({ status: payload.status, admin_note: payload.adminNote || null, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('id, status, admin_note, updated_at')
        .single();
      if (error) throw error;
      return data;
    }
  };
}
