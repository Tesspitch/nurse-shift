export function createAdminRepository(supabase) {
  async function assertAdmin(userId) {
    const { data, error } = await supabase
      .from('admin_users')
      .select('user_id, role, display_name, active')
      .eq('user_id', userId)
      .eq('active', true)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      const denied = new Error('ADMIN_ACCESS_REQUIRED');
      denied.status = 403;
      throw denied;
    }
    return data;
  }

  async function listUsers() {
    const [{ data: profiles, error: profilesError }, { data: controls, error: controlsError }, { data: shifts, error: shiftsError }] = await Promise.all([
      supabase.from('profiles').select('id, display_name, picture_url, line_user_id, created_at, updated_at').order('updated_at', { ascending: false }),
      supabase.from('user_admin_controls').select('user_id, status, note, updated_at'),
      supabase.from('shifts').select('user_id')
    ]);
    if (profilesError) throw profilesError;
    if (controlsError) throw controlsError;
    if (shiftsError) throw shiftsError;
    const controlsByUser = new Map((controls || []).map((item) => [item.user_id, item]));
    const counts = new Map();
    for (const shift of shifts || []) counts.set(shift.user_id, (counts.get(shift.user_id) || 0) + 1);
    return (profiles || []).map((profile) => ({
      ...profile,
      status: controlsByUser.get(profile.id)?.status || 'active',
      adminNote: controlsByUser.get(profile.id)?.note || '',
      shiftCount: counts.get(profile.id) || 0
    }));
  }

  async function getUser(userId) {
    const [{ data: profile, error: profileError }, { data: shifts, error: shiftsError }, { data: feedback, error: feedbackError }] = await Promise.all([
      supabase.from('profiles').select('id, display_name, picture_url, line_user_id, created_at, updated_at').eq('id', userId).single(),
      supabase.from('shifts').select('id, shift_type_id, work_date, start_time, end_time, urgent_ot_hours, note, created_at, shift_types(name, premium)').eq('user_id', userId).order('work_date', { ascending: false }),
      supabase.from('feedback').select('id, category, message, status, admin_note, created_at, updated_at').eq('user_id', userId).order('created_at', { ascending: false })
    ]);
    if (profileError) throw profileError;
    if (shiftsError) throw shiftsError;
    if (feedbackError) throw feedbackError;
    return { profile, shifts: shifts || [], feedback: feedback || [] };
  }

  async function setUserStatus(userId, status, note) {
    const { data, error } = await supabase
      .from('user_admin_controls')
      .upsert({ user_id: userId, status, note: note || null, updated_at: new Date().toISOString() })
      .select('user_id, status, note, updated_at')
      .single();
    if (error) throw error;
    return data;
  }

  return { assertAdmin, listUsers, getUser, setUserStatus };
}
