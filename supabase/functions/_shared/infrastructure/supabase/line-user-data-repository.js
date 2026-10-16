import { bangkokMonthRange } from '../../domain/bangkok-calendar.js';

export function createLineUserDataRepository(supabase, { now = () => new Date() } = {}) {
  return {
    async getProfile(lineUserId) {
      const { data, error } = await supabase.from('profiles')
        .select('id')
        .eq('line_user_id', lineUserId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },

    async getMonthData(userId) {
      const range = bangkokMonthRange(now());
      const [settings, types, shifts, specialOt, dayOffs, financialItems] = await Promise.all([
        supabase.from('user_settings').select('salary, license_allowance, ot_rate, standard_hours').eq('user_id', userId).single(),
        supabase.from('shift_types').select('id, name, premium').eq('user_id', userId).order('sort_order'),
        supabase.from('shifts').select('shift_type_id, work_date, start_time, end_time').eq('user_id', userId).gte('work_date', range.start).lte('work_date', range.end),
        supabase.from('special_ot_items').select('work_date, hours').eq('user_id', userId).gte('work_date', range.start).lte('work_date', range.end),
        supabase.from('day_offs').select('work_date').eq('user_id', userId).gte('work_date', range.start).lte('work_date', range.end).order('work_date'),
        supabase.from('financial_items').select('kind, amount, work_date').eq('user_id', userId).gte('work_date', range.start).lte('work_date', range.end)
      ]);
      const error = settings.error || types.error || shifts.error || specialOt.error || dayOffs.error || financialItems.error;
      if (error) throw error;
      return {
        range,
        settings: settings.data,
        shiftTypes: types.data,
        shifts: shifts.data,
        specialOtItems: specialOt.data,
        dayOffs: dayOffs.data,
        financialItems: financialItems.data
      };
    },

    async getNextShift(userId) {
      const currentTime = now();
      const dateParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(currentTime);
      const dateValue = (type) => dateParts.find((part) => part.type === type)?.value;
      const today = `${dateValue('year')}-${dateValue('month')}-${dateValue('day')}`;
      const { data, error } = await supabase.from('shifts')
        .select('work_date, start_time, end_time, shift_types!inner(name)')
        .eq('user_id', userId)
        .gte('work_date', today)
        .order('work_date')
        .order('start_time')
        .limit(31);
      if (error) throw error;
      const shift = data.find((item) => new Date(`${item.work_date}T${String(item.start_time).slice(0, 5)}:00+07:00`) >= currentTime) || null;
      return shift ? { ...shift, shift_name: shift.shift_types.name } : null;
    }
  };
}
