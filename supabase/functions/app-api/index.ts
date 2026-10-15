import { createClient } from 'npm:@supabase/supabase-js@2.112.3';
import { nextRunAt, validateNotificationRule } from '../_shared/notification-scheduling.js';

type VerifiedLineUser = { sub: string; name?: string; picture?: string };

const DEFAULT_ORIGINS = [
  'https://costnurse.vercel.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
];
const allowedOrigins = new Set(
  (Deno.env.get('ALLOWED_WEB_ORIGINS') || DEFAULT_ORIGINS.join(','))
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean)
);
const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  secretKeys.default ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } }
);

const validationCodes = new Set([
  'INVALID_STATE', 'INVALID_SETTINGS', 'INVALID_STANDARD_HOURS', 'INVALID_CYCLE_START_DAY',
  'INVALID_COLLECTIONS', 'SHIFT_TYPES_REQUIRED', 'INVALID_SHIFT_TYPE', 'INVALID_SHIFT',
  'INVALID_SPECIAL_OT_ITEM', 'INVALID_DAY_OFF', 'INVALID_DAY_OFF_CONFLICT', 'INVALID_FINANCIAL_ITEM', 'INVALID_REMINDER', 'INVALID_HISTORY_MONTH', 'DUPLICATE_ID', 'PAYLOAD_TOO_LARGE',
  'INVALID_NOTIFICATION_RULE', 'INVALID_SCHEDULE_KIND', 'INVALID_TIMEZONE', 'INVALID_SCHEDULE_TIME',
  'INVALID_SCHEDULE_AT', 'INVALID_SCHEDULE_WEEKDAY', 'INVALID_SCHEDULE_DAY'
]);

function requestOrigin(request: Request) {
  return (request.headers.get('origin') || '').replace(/\/$/, '');
}

function corsHeaders(request: Request) {
  const origin = requestOrigin(request);
  return {
    ...(origin && allowedOrigins.has(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-line-id-token, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  };
}

function jsonResponse(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function assertAllowedOrigin(request: Request) {
  const origin = requestOrigin(request);
  if (origin && !allowedOrigins.has(origin)) throw new Error('ORIGIN_NOT_ALLOWED');
}

async function verifyLineIdToken(idToken: string): Promise<VerifiedLineUser> {
  const channelId = Deno.env.get('LINE_LOGIN_CHANNEL_ID');
  if (!channelId) throw new Error('SERVER_CONFIGURATION_ERROR');
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

async function authenticateRequest(request: Request) {
  const idToken = request.headers.get('x-line-id-token');
  if (!idToken) throw new Error('LINE_ID_TOKEN_REQUIRED');
  return verifyLineIdToken(idToken);
}

const defaultShiftTypes = [
  { id: 'morning', name: 'เวรเช้า', start_time: '08:00', end_time: '16:00', premium: 0, color: '#F59E0B', sort_order: 1 },
  { id: 'evening', name: 'เวรบ่าย', start_time: '16:00', end_time: '00:00', premium: 200, color: '#8B5CF6', sort_order: 2 },
  { id: 'night', name: 'เวรดึก', start_time: '00:00', end_time: '08:00', premium: 300, color: '#2563EB', sort_order: 3 }
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
  const [settingsResult, typesResult, shiftsResult, specialOtResult, dayOffsResult, itemsResult, remindersResult] = await Promise.all([
    supabase.from('user_settings').select('*').eq('user_id', profile.id).single(),
    supabase.from('shift_types').select('*').eq('user_id', profile.id).order('sort_order'),
    supabase.from('shifts').select('*').eq('user_id', profile.id).order('work_date').order('start_time'),
    supabase.from('special_ot_items').select('*').eq('user_id', profile.id).order('work_date'),
    supabase.from('day_offs').select('*').eq('user_id', profile.id).order('work_date'),
    supabase.from('financial_items').select('*').eq('user_id', profile.id).order('work_date'),
    supabase.from('reminders').select('*').eq('user_id', profile.id).order('offset_minutes', { ascending: false })
  ]);
  const error = settingsResult.error || typesResult.error || shiftsResult.error || specialOtResult.error || dayOffsResult.error || itemsResult.error || remindersResult.error;
  if (error) throw error;
  const settings = settingsResult.data;
  const shiftsById = new Map(shiftsResult.data.map((shift) => [shift.id, shift]));
  const specialOtItems = specialOtResult.data.map((item) => {
    const legacyShift = item.origin_shift_id ? shiftsById.get(item.origin_shift_id) : null;
    return {
      id: item.id,
      workDate: item.work_date,
      hours: legacyShift && legacyShift.urgent_ot_hours > 0 ? legacyShift.urgent_ot_hours : item.hours,
      note: item.note || ''
    };
  });
  return {
    version: Number(settings.state_version || 0),
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
      notificationsEnabled: settings.notifications_enabled,
      expirationNotificationsEnabled: settings.expiration_notifications_enabled
    },
    shiftTypes: typesResult.data.map((type) => ({ id: type.id, name: type.name, startTime: type.start_time.slice(0, 5), endTime: type.end_time.slice(0, 5), premium: Number(type.premium), color: type.color })),
    shifts: shiftsResult.data.map((shift) => ({ id: shift.id, shiftTypeId: shift.shift_type_id, workDate: shift.work_date, startTime: shift.start_time.slice(0, 5), endTime: shift.end_time.slice(0, 5), urgentOtHours: 0, note: shift.note || '' })),
    specialOtItems,
    dayOffs: dayOffsResult.data.map((item) => ({ id: item.id, workDate: item.work_date })),
    financialItems: itemsResult.data.map((item) => ({ id: item.id, kind: item.kind, label: item.label, amount: Number(item.amount), workDate: item.work_date })),
    reminders: remindersResult.data.map((reminder) => ({ id: reminder.id, offsetMinutes: reminder.offset_minutes, enabled: reminder.enabled }))
  };
}

function bangkokMonthKey() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find((part) => part.type === 'year')?.value}-${parts.find((part) => part.type === 'month')?.value}`;
}

function shiftMonthKey(monthKey: string, amount: number) {
  const [year, month] = monthKey.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

function historyMonthRange(monthKey: string) {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(monthKey)) throw new Error('INVALID_HISTORY_MONTH');
  const current = bangkokMonthKey();
  if (![shiftMonthKey(current, -2), shiftMonthKey(current, -1), current].includes(monthKey)) throw new Error('INVALID_HISTORY_MONTH');
  const next = shiftMonthKey(monthKey, 1);
  const [nextYear, nextMonth] = next.split('-').map(Number);
  const end = new Date(Date.UTC(nextYear, nextMonth - 1, 0)).toISOString().slice(0, 10);
  return { start: `${monthKey}-01`, end };
}

async function getMonthState(profile: { id: string }, monthKey: string) {
  const range = historyMonthRange(monthKey);
  const [shiftsResult, specialOtResult, dayOffsResult, itemsResult] = await Promise.all([
    supabase.from('shifts').select('*').eq('user_id', profile.id).gte('work_date', range.start).lte('work_date', range.end).order('work_date').order('start_time'),
    supabase.from('special_ot_items').select('*').eq('user_id', profile.id).gte('work_date', range.start).lte('work_date', range.end).order('work_date'),
    supabase.from('day_offs').select('*').eq('user_id', profile.id).gte('work_date', range.start).lte('work_date', range.end).order('work_date'),
    supabase.from('financial_items').select('*').eq('user_id', profile.id).gte('work_date', range.start).lte('work_date', range.end).order('work_date')
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

function isFiniteNumber(value: unknown, min: number, max: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max;
}
function isDate(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
function isTime(value: unknown) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}
function assertUniqueIds(items: Array<Record<string, unknown>>) {
  const ids = items.map((item) => String(item.id || ''));
  if (new Set(ids).size !== ids.length) throw new Error('DUPLICATE_ID');
}

function validateState(state: Record<string, unknown>) {
  if (!state || typeof state !== 'object') throw new Error('INVALID_STATE');
  if (!Number.isSafeInteger(Number(state.version)) || Number(state.version) < 0) throw new Error('INVALID_STATE');
  const settings = state.settings as Record<string, unknown>;
  if (!settings) throw new Error('INVALID_SETTINGS');
  for (const field of ['salary', 'licenseAllowance', 'otRate']) {
    if (!isFiniteNumber(settings[field], 0, 100_000_000)) throw new Error('INVALID_SETTINGS');
  }
  if (!isFiniteNumber(settings.uncertaintyBuffer, 0, 10_000_000)) throw new Error('INVALID_SETTINGS');
  if (!Number.isInteger(Number(settings.standardHours)) || !isFiniteNumber(settings.standardHours, 1, 744)) throw new Error('INVALID_STANDARD_HOURS');
  if (!Number.isInteger(Number(settings.cycleStartDay)) || !isFiniteNumber(settings.cycleStartDay, 1, 28)) throw new Error('INVALID_CYCLE_START_DAY');
  if (settings.confirmedCycle != null && !isDate(settings.confirmedCycle)) throw new Error('INVALID_SETTINGS');
  if (settings.expirationNotificationsEnabled != null && typeof settings.expirationNotificationsEnabled !== 'boolean') throw new Error('INVALID_SETTINGS');

  const shiftTypes = state.shiftTypes as Array<Record<string, unknown>>;
  const shifts = state.shifts as Array<Record<string, unknown>>;
  const specialOtItems = state.specialOtItems as Array<Record<string, unknown>>;
  const dayOffs = state.dayOffs as Array<Record<string, unknown>>;
  const items = state.financialItems as Array<Record<string, unknown>>;
  const reminders = state.reminders as Array<Record<string, unknown>>;
  if (![shiftTypes, shifts, specialOtItems, dayOffs, items, reminders].every(Array.isArray)) throw new Error('INVALID_COLLECTIONS');
  if (shiftTypes.length < 1 || shiftTypes.length > 20) throw new Error('SHIFT_TYPES_REQUIRED');
  if (shifts.length > 5000 || specialOtItems.length > 5000 || dayOffs.length > 5000 || items.length > 5000 || reminders.length > 20) throw new Error('PAYLOAD_TOO_LARGE');
  assertUniqueIds(shiftTypes); assertUniqueIds(shifts); assertUniqueIds(specialOtItems); assertUniqueIds(dayOffs); assertUniqueIds(items); assertUniqueIds(reminders);

  const typeIds = new Set<string>();
  for (const type of shiftTypes) {
    if (typeof type.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(type.id)
      || typeof type.name !== 'string' || type.name.trim().length < 1 || type.name.length > 40
      || !isTime(type.startTime) || !isTime(type.endTime)
      || !isFiniteNumber(type.premium, 0, 10_000_000)
      || typeof type.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(type.color)) throw new Error('INVALID_SHIFT_TYPE');
    typeIds.add(type.id);
  }
  for (const shift of shifts) {
    if (typeof shift.id !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(shift.id)
      || typeof shift.shiftTypeId !== 'string' || !typeIds.has(shift.shiftTypeId)
      || !isDate(shift.workDate) || !isTime(shift.startTime) || !isTime(shift.endTime)
      || !Number.isInteger(Number(shift.urgentOtHours)) || !isFiniteNumber(shift.urgentOtHours, 0, 24)
      || typeof shift.note !== 'string' || shift.note.length > 120) throw new Error('INVALID_SHIFT');
  }
  for (const item of specialOtItems) {
    if (typeof item.id !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(item.id)
      || !isDate(item.workDate) || !Number.isInteger(Number(item.hours))
      || !isFiniteNumber(item.hours, 1, 24)
      || typeof item.note !== 'string' || item.note.length > 120) throw new Error('INVALID_SPECIAL_OT_ITEM');
  }
  const dayOffDates = new Set<string>();
  for (const item of dayOffs) {
    if (typeof item.id !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(item.id) || !isDate(item.workDate)
      || dayOffDates.has(String(item.workDate))) throw new Error('INVALID_DAY_OFF');
    dayOffDates.add(String(item.workDate));
  }
  if (shifts.some((shift) => dayOffDates.has(String(shift.workDate)))) throw new Error('INVALID_DAY_OFF_CONFLICT');
  for (const item of items) {
    if (typeof item.id !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(item.id)
      || !['income', 'deduction'].includes(String(item.kind))
      || typeof item.label !== 'string' || item.label.trim().length < 1 || item.label.length > 80
      || !isFiniteNumber(item.amount, 0, 100_000_000) || !isDate(item.workDate)) throw new Error('INVALID_FINANCIAL_ITEM');
  }
  for (const reminder of reminders) {
    if (typeof reminder.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(reminder.id)
      || !Number.isInteger(Number(reminder.offsetMinutes)) || !isFiniteNumber(reminder.offsetMinutes, 5, 43_200)
      || typeof reminder.enabled !== 'boolean') throw new Error('INVALID_REMINDER');
  }
}

async function pushTestNotification(lineUserId: string) {
  const channelAccessToken = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN');
  if (!channelAccessToken) throw new Error('SERVER_CONFIGURATION_ERROR');
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { Authorization: `Bearer ${channelAccessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text: 'ทดสอบแจ้งเตือน NurseShift สำเร็จ\nระบบพร้อมส่งการแจ้งเตือนเวรให้คุณแล้ว' }] })
  });
  if (!response.ok) throw new Error('LINE_PUSH_FAILED');
}

function validatedNotificationRule(payload: Record<string, unknown>) {
  const scheduleKind = String(payload.scheduleKind || '');
  const timezone = String(payload.timezone || 'Asia/Bangkok');
  const scheduleConfig = payload.scheduleConfig as Record<string, unknown>;
  const notificationType = String(payload.notificationType || 'custom');
  if (!['custom', 'ot_reminder'].includes(notificationType) || !scheduleConfig || typeof scheduleConfig !== 'object') {
    throw new Error('INVALID_NOTIFICATION_RULE');
  }
  const message = String((scheduleConfig.payload as Record<string, unknown> | undefined)?.message || '');
  if (message.length > 500) throw new Error('INVALID_NOTIFICATION_RULE');
  const rule = { scheduleKind, timezone, scheduleConfig };
  validateNotificationRule(rule);
  const scheduledFor = nextRunAt(rule, new Date());
  if (!scheduledFor) throw new Error('INVALID_NOTIFICATION_RULE');
  const id = payload.id == null || payload.id === '' ? null : String(payload.id);
  if (id && !/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error('INVALID_NOTIFICATION_RULE');
  return { id, notificationType, scheduleKind, timezone, scheduleConfig, scheduledFor };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    if (requestOrigin(request) && !allowedOrigins.has(requestOrigin(request))) return jsonResponse(request, { error: 'ORIGIN_NOT_ALLOWED' }, 403);
    return new Response('ok', { headers: corsHeaders(request) });
  }
  if (request.method !== 'POST') return jsonResponse(request, { error: 'METHOD_NOT_ALLOWED' }, 405);
  const requestId = crypto.randomUUID();
  try {
    assertAllowedOrigin(request);
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 1_000_000) throw new Error('PAYLOAD_TOO_LARGE');
    const lineUser = await authenticateRequest(request);
    const profile = await ensureProfile(lineUser);
    const rawBody = await request.text();
    if (rawBody.length > 1_000_000) throw new Error('PAYLOAD_TOO_LARGE');
    const { action, payload = {} } = JSON.parse(rawBody || '{}');

    if (action === 'bootstrap') return jsonResponse(request, { data: await getState(profile) });
    if (action === 'month-history') return jsonResponse(request, { data: await getMonthState(profile, String(payload.month || '')) });
    if (action === 'list-notification-rules') {
      const { data, error } = await supabase.from('notification_rules')
        .select('id, notification_type, schedule_kind, timezone, schedule_config, enabled, generation, created_at, updated_at')
        .eq('user_id', profile.id).is('source_shift_id', null).order('created_at');
      if (error) throw error;
      return jsonResponse(request, { data: data ?? [] });
    }
    if (action === 'upsert-notification-rule') {
      const rule = validatedNotificationRule(payload as Record<string, unknown>);
      const { data: id, error } = await supabase.rpc('upsert_notification_rule_v2', {
        p_user_id: profile.id,
        p_rule_id: rule.id,
        p_notification_type: rule.notificationType,
        p_schedule_kind: rule.scheduleKind,
        p_timezone: rule.timezone,
        p_schedule_config: rule.scheduleConfig,
        p_scheduled_for: rule.scheduledFor.toISOString()
      });
      if (error) throw error;
      return jsonResponse(request, { data: { id, scheduledFor: rule.scheduledFor.toISOString(), mode: 'shadow' } });
    }
    if (action === 'cancel-notification-rule') {
      const id = String(payload.id || '');
      if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw new Error('INVALID_NOTIFICATION_RULE');
      const { data: cancelled, error } = await supabase.rpc('cancel_notification_rule_v2', { p_user_id: profile.id, p_rule_id: id });
      if (error) throw error;
      return jsonResponse(request, { data: { cancelled: Boolean(cancelled) } });
    }
    if (action === 'replace-state') {
      validateState(payload);
      const { data: version, error } = await supabase.rpc('replace_user_state_v2', { p_user_id: profile.id, p_state: payload, p_expected_version: Number(payload.version) });
      if (error) {
        if (error.message?.includes('STATE_VERSION_CONFLICT') || error.code === '40001') throw new Error('STATE_VERSION_CONFLICT');
        throw error;
      }
      return jsonResponse(request, { data: { version: Number(version) } });
    }
    if (action === 'test-notification') {
      const { data: claimed, error } = await supabase.rpc('claim_test_notification', { p_user_id: profile.id });
      if (error) throw error;
      if (!claimed) throw new Error('NOTIFICATION_RATE_LIMITED');
      await pushTestNotification(lineUser.sub);
      return jsonResponse(request, { data: { sent: true } });
    }
    if (action === 'delete-account') {
      const { error } = await supabase.from('profiles').delete().eq('id', profile.id);
      if (error) throw error;
      return jsonResponse(request, { data: { deleted: true } });
    }
    return jsonResponse(request, { error: 'UNKNOWN_ACTION' }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'INTERNAL_ERROR';
    if (message === 'ORIGIN_NOT_ALLOWED') return jsonResponse(request, { error: message }, 403);
    if (message.startsWith('LINE_')) return jsonResponse(request, { error: message }, 401);
    if (message === 'STATE_VERSION_CONFLICT') return jsonResponse(request, { error: message }, 409);
    if (message === 'NOTIFICATION_RATE_LIMITED') return jsonResponse(request, { error: message }, 429);
    if (message === 'LINE_PUSH_FAILED') return jsonResponse(request, { error: message }, 502);
    if (message === 'PAYLOAD_TOO_LARGE') return jsonResponse(request, { error: message }, 413);
    if (validationCodes.has(message) || error instanceof SyntaxError) return jsonResponse(request, { error: error instanceof SyntaxError ? 'INVALID_JSON' : message }, 400);
    console.error(JSON.stringify({ requestId, error: message }));
    return jsonResponse(request, { error: 'INTERNAL_ERROR', requestId }, 500);
  }
});
