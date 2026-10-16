export function createHistoryRepository(supabase) {
  return {
    async getMonth(userId, range) {
      const [shiftsResult, specialOtResult, dayOffsResult, itemsResult] = await Promise.all([
        supabase.from('shifts').select('*').eq('user_id', userId).gte('work_date', range.start).lte('work_date', range.end).order('work_date').order('start_time'),
        supabase.from('special_ot_items').select('*').eq('user_id', userId).gte('work_date', range.start).lte('work_date', range.end).order('work_date'),
        supabase.from('day_offs').select('*').eq('user_id', userId).gte('work_date', range.start).lte('work_date', range.end).order('work_date'),
        supabase.from('financial_items').select('*').eq('user_id', userId).gte('work_date', range.start).lte('work_date', range.end).order('work_date')
      ]);
      const error = shiftsResult.error || specialOtResult.error || dayOffsResult.error || itemsResult.error;
      if (error) throw error;
      return {
        shifts: shiftsResult.data.map((shift) => ({ id: shift.id, shiftTypeId: shift.shift_type_id, workDate: shift.work_date, startTime: shift.start_time.slice(0, 5), endTime: shift.end_time.slice(0, 5), urgentOtHours: 0, note: shift.note || '' })),
        specialOtItems: specialOtResult.data.map((item) => ({ id: item.id, workDate: item.work_date, hours: item.hours, note: item.note || '' })),
        dayOffs: dayOffsResult.data.map((item) => ({ id: item.id, workDate: item.work_date })),
        financialItems: itemsResult.data.map((item) => ({ id: item.id, kind: item.kind, label: item.label, amount: Number(item.amount), workDate: item.work_date }))
      };
    }
  };
}
