const defaultShiftTypes = [
  { id: 'morning', name: 'เวรเช้า', start_time: '08:00', end_time: '16:00', premium: 0, color: '#F59E0B', sort_order: 1 },
  { id: 'evening', name: 'เวรบ่าย', start_time: '16:00', end_time: '00:00', premium: 200, color: '#8B5CF6', sort_order: 2 },
  { id: 'night', name: 'เวรดึก', start_time: '00:00', end_time: '08:00', premium: 300, color: '#2563EB', sort_order: 3 }
];

export function createUserStateRepository(supabase, { cacheTtlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
  const profileCache = new Map();
  return {
    async ensureProfile(lineUser) {
      const cached = profileCache.get(lineUser.sub);
      if (cached && cached.expiresAt > now()) return cached.profile;
      const { data: existing, error: lookupError } = await supabase.from('profiles').select('id, display_name, picture_url').eq('line_user_id', lineUser.sub).maybeSingle();
      if (lookupError) throw lookupError;
      if (existing) {
        const displayName = lineUser.name || 'ผู้ใช้งาน';
        const pictureUrl = lineUser.picture || null;
        let profile = existing;
        if (existing.display_name !== displayName || existing.picture_url !== pictureUrl) {
          const { data, error } = await supabase.from('profiles').update({ display_name: displayName, picture_url: pictureUrl, updated_at: new Date().toISOString() }).eq('id', existing.id).select('id, display_name, picture_url').single();
          if (error) throw error;
          profile = data;
        }
        profileCache.set(lineUser.sub, { profile, expiresAt: now() + cacheTtlMs });
        return profile;
      }
      const { data: profile, error } = await supabase.from('profiles').upsert({ line_user_id: lineUser.sub, display_name: lineUser.name || 'ผู้ใช้งาน', picture_url: lineUser.picture || null, updated_at: new Date().toISOString() }, { onConflict: 'line_user_id' }).select('id, display_name, picture_url').single();
      if (error) throw error;
      const results = await Promise.all([
        supabase.from('user_settings').upsert({ user_id: profile.id }, { onConflict: 'user_id', ignoreDuplicates: true }),
        supabase.from('shift_types').upsert(defaultShiftTypes.map((type) => ({ ...type, user_id: profile.id })), { onConflict: 'user_id,id', ignoreDuplicates: true }),
        supabase.from('reminders').upsert([{ user_id: profile.id, id: 'one-day', offset_minutes: 1440, enabled: true }, { user_id: profile.id, id: 'one-hour', offset_minutes: 60, enabled: true }], { onConflict: 'user_id,id', ignoreDuplicates: true })
      ]);
      const setupError = results.find((result) => result.error)?.error;
      if (setupError) throw setupError;
      profileCache.set(lineUser.sub, { profile, expiresAt: now() + cacheTtlMs });
      return profile;
    },

    async getState(profile) {
      const [settingsResult, typesResult, shiftsResult, specialOtResult, dayOffsResult, itemsResult, remindersResult] = await Promise.all([
        supabase.from('user_settings').select('*').eq('user_id', profile.id).single(),
        supabase.from('shift_types').select('*').eq('user_id', profile.id).order('sort_order'),
        supabase.from('shifts').select('*').eq('user_id', profile.id).order('work_date').order('start_time'),
        supabase.from('special_ot_items').select('*').eq('user_id', profile.id).order('work_date'),
        supabase.from('day_offs').select('*').eq('user_id', profile.id).order('work_date'),
        supabase.from('financial_items').select('*').eq('user_id', profile.id).order('work_date'),
        supabase.from('reminders').select('*').eq('user_id', profile.id).order('offset_minutes', { ascending: false })
      ]);
      const error = [settingsResult, typesResult, shiftsResult, specialOtResult, dayOffsResult, itemsResult, remindersResult].find((result) => result.error)?.error;
      if (error) throw error;
      const settings = settingsResult.data;
      const shiftsById = new Map(shiftsResult.data.map((shift) => [shift.id, shift]));
      return {
        version: Number(settings.state_version || 0),
        profile: { displayName: profile.display_name, pictureUrl: profile.picture_url || '' },
        settings: {
          onboardingComplete: settings.onboarding_complete, salary: Number(settings.salary), licenseAllowance: Number(settings.license_allowance),
          otRate: Number(settings.ot_rate), standardHours: settings.standard_hours, cycleStartDay: settings.cycle_start_day,
          uncertaintyBuffer: Number(settings.uncertainty_buffer), confirmedCycle: settings.confirmed_cycle,
          notificationsEnabled: settings.notifications_enabled, expirationNotificationsEnabled: settings.expiration_notifications_enabled
        },
        shiftTypes: typesResult.data.map((type) => ({ id: type.id, name: type.name, startTime: type.start_time.slice(0, 5), endTime: type.end_time.slice(0, 5), premium: Number(type.premium), color: type.color })),
        shifts: shiftsResult.data.map((shift) => ({ id: shift.id, shiftTypeId: shift.shift_type_id, workDate: shift.work_date, startTime: shift.start_time.slice(0, 5), endTime: shift.end_time.slice(0, 5), urgentOtHours: 0, note: shift.note || '' })),
        specialOtItems: specialOtResult.data.map((item) => { const legacy = item.origin_shift_id ? shiftsById.get(item.origin_shift_id) : null; return { id: item.id, workDate: item.work_date, hours: legacy && legacy.urgent_ot_hours > 0 ? legacy.urgent_ot_hours : item.hours, note: item.note || '' }; }),
        dayOffs: dayOffsResult.data.map((item) => ({ id: item.id, workDate: item.work_date })),
        financialItems: itemsResult.data.map((item) => ({ id: item.id, kind: item.kind, label: item.label, amount: Number(item.amount), workDate: item.work_date })),
        reminders: remindersResult.data.map((item) => ({ id: item.id, offsetMinutes: item.offset_minutes, enabled: item.enabled }))
      };
    },

    async replace(userId, state) {
      const { data, error } = await supabase.rpc('replace_user_state_v2', { p_user_id: userId, p_state: state, p_expected_version: Number(state.version) });
      if (error?.message?.includes('STATE_VERSION_CONFLICT') || error?.code === '40001') throw new Error('STATE_VERSION_CONFLICT');
      if (error) throw error;
      return Number(data);
    },

    async delete(profile, lineUserId) {
      const { error } = await supabase.from('profiles').delete().eq('id', profile.id);
      if (error) throw error;
      profileCache.delete(lineUserId);
    }
  };
}
