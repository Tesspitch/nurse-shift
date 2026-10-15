import { createClient } from 'npm:@supabase/supabase-js@2.112.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-line-id-token, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

type VerifiedLineUser = {
  sub: string;
  name?: string;
  picture?: string;
};

async function verifyLineIdToken(idToken: string): Promise<VerifiedLineUser> {
  const channelId = Deno.env.get('LINE_LOGIN_CHANNEL_ID');
  if (!channelId) throw new Error('LINE_LOGIN_CHANNEL_ID is not configured');

  const response = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: channelId })
  });
  if (!response.ok) throw new Error('LINE_ID_TOKEN_INVALID');
  const payload = await response.json();
  if (!payload.sub) throw new Error('LINE_USER_ID_MISSING');
  return payload as VerifiedLineUser;
}

async function authenticateRequest(request: Request): Promise<VerifiedLineUser> {
  const idToken = request.headers.get('x-line-id-token');
  if (idToken) return verifyLineIdToken(idToken);

  const origin = request.headers.get('origin') ?? '';
  const isLocalDevelopment = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (isLocalDevelopment) {
    return { sub: 'local-development-user', name: 'ผู้ทดสอบ Local' };
  }

  throw new Error('LINE_ID_TOKEN_REQUIRED');
}

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
const serviceRoleKey = secretKeys.default ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

const defaultShiftTypes = [
  { id: 'morning', name: 'เวรเช้า', start_time: '08:00', end_time: '16:00', premium: 0, color: '#B7791F', sort_order: 1 },
  { id: 'evening', name: 'เวรบ่าย', start_time: '16:00', end_time: '00:00', premium: 200, color: '#9B285B', sort_order: 2 },
  { id: 'night', name: 'เวรดึก', start_time: '00:00', end_time: '08:00', premium: 300, color: '#3559A8', sort_order: 3 }
];

async function ensureProfile(lineUser: VerifiedLineUser) {
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .upsert({ line_user_id: lineUser.sub, display_name: lineUser.name || 'ผู้ใช้งาน', picture_url: lineUser.picture || null, updated_at: new Date().toISOString() }, { onConflict: 'line_user_id' })
    .select('id, display_name, picture_url')
    .single();
  if (profileError) throw profileError;

  const { error: settingsError } = await supabase.from('user_settings').upsert({ user_id: profile.id }, { onConflict: 'user_id', ignoreDuplicates: true });
  if (settingsError) throw settingsError;
  const { error: typesError } = await supabase.from('shift_types').upsert(defaultShiftTypes.map((type) => ({ ...type, user_id: profile.id })), { onConflict: 'user_id,id', ignoreDuplicates: true });
  if (typesError) throw typesError;
  const { error: remindersError } = await supabase.from('reminders').upsert([
    { user_id: profile.id, id: 'one-day', offset_minutes: 1440, enabled: true },
    { user_id: profile.id, id: 'one-hour', offset_minutes: 60, enabled: true }
  ], { onConflict: 'user_id,id', ignoreDuplicates: true });
  if (remindersError) throw remindersError;
  return profile;
}

async function getState(profile: { id: string; display_name: string; picture_url: string | null }) {
  const [settingsResult, typesResult, shiftsResult, itemsResult, remindersResult] = await Promise.all([
    supabase.from('user_settings').select('*').eq('user_id', profile.id).single(),
    supabase.from('shift_types').select('*').eq('user_id', profile.id).order('sort_order'),
    supabase.from('shifts').select('*').eq('user_id', profile.id).order('work_date').order('start_time'),
    supabase.from('financial_items').select('*').eq('user_id', profile.id).order('work_date'),
    supabase.from('reminders').select('*').eq('user_id', profile.id).order('offset_minutes', { ascending: false })
  ]);
  const error = settingsResult.error || typesResult.error || shiftsResult.error || itemsResult.error || remindersResult.error;
  if (error) throw error;
  const settings = settingsResult.data;
  return {
    profile: { displayName: profile.display_name, pictureUrl: profile.picture_url || '' },
    settings: {
      onboardingComplete: settings.onboarding_complete,
      salary: Number(settings.salary),
      licenseAllowance: Number(settings.license_allowance),
      otRate: Number(settings.ot_rate),
      standardHours: settings.standard_hours,
      cycleStartDay: settings.cycle_start_day,
      uncertaintyBuffer: Number(settings.uncertainty_buffer),
      confirmedCycle: settings.confirmed_cycle,
      notificationsEnabled: settings.notifications_enabled
    },
    shiftTypes: typesResult.data.map((type) => ({ id: type.id, name: type.name, startTime: type.start_time.slice(0, 5), endTime: type.end_time.slice(0, 5), premium: Number(type.premium), color: type.color })),
    shifts: shiftsResult.data.map((shift) => ({ id: shift.id, shiftTypeId: shift.shift_type_id, workDate: shift.work_date, startTime: shift.start_time.slice(0, 5), endTime: shift.end_time.slice(0, 5), urgentOtHours: shift.urgent_ot_hours, note: shift.note || '' })),
    financialItems: itemsResult.data.map((item) => ({ id: item.id, kind: item.kind, label: item.label, amount: Number(item.amount), workDate: item.work_date })),
    reminders: remindersResult.data.map((reminder) => ({ id: reminder.id, offsetMinutes: reminder.offset_minutes, enabled: reminder.enabled }))
  };
}

function validateState(state: Record<string, unknown>) {
  if (!state || typeof state !== 'object') throw new Error('INVALID_STATE');
  const settings = state.settings as Record<string, unknown>;
  if (!settings || Number(settings.standardHours) <= 0) throw new Error('INVALID_STANDARD_HOURS');
  if (Number(settings.cycleStartDay) < 1 || Number(settings.cycleStartDay) > 28) throw new Error('INVALID_CYCLE_START_DAY');
  if (!Array.isArray(state.shiftTypes) || state.shiftTypes.length === 0) throw new Error('SHIFT_TYPES_REQUIRED');
  if (!Array.isArray(state.shifts) || !Array.isArray(state.financialItems) || !Array.isArray(state.reminders)) throw new Error('INVALID_COLLECTIONS');
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405);

  try {
    const lineUser = await authenticateRequest(request);
    const profile = await ensureProfile(lineUser);
    const { action, payload } = await request.json();

    if (action === 'bootstrap') return jsonResponse({ data: await getState(profile) });
    if (action === 'replace-state') {
      validateState(payload);
      const { error } = await supabase.rpc('replace_user_state', { p_user_id: profile.id, p_state: payload });
      if (error) throw error;
      return jsonResponse({ data: await getState(profile) });
    }
    return jsonResponse({ error: 'UNKNOWN_ACTION' }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'INTERNAL_ERROR';
    const status = message.startsWith('LINE_') ? 401 : 400;
    return jsonResponse({ error: message }, status);
  }
});
