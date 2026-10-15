import { createClient } from 'npm:@supabase/supabase-js@2.112.3';
import { bangkokMonthRange, calculateBotMonthSummary, canShowActionInSource, createFlexMessage, parsePostbackAction, verifyLineSignature } from '../_shared/line-bot.js';

const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  secretKeys.default ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } }
);
const channelSecret = Deno.env.get('LINE_MESSAGING_CHANNEL_SECRET') ?? '';
const channelAccessToken = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') ?? '';
const liffUrl = (Deno.env.get('LINE_LIFF_URL') || 'https://liff.line.me/2012030979-CQQzGFWo').replace(/\/$/, '');

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

async function reply(replyToken: string, messages: unknown[]) {
  const response = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { Authorization: `Bearer ${channelAccessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages })
  });
  if (!response.ok) throw new Error(`LINE_REPLY_FAILED_${response.status}`);
}

async function linkRichMenu(lineUserId: string, richMenuId: string) {
  const response = await fetch(`https://api.line.me/v2/bot/user/${encodeURIComponent(lineUserId)}/richmenu/${encodeURIComponent(richMenuId)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${channelAccessToken}` }
  });
  if (!response.ok) throw new Error(`LINE_RICH_MENU_LINK_FAILED_${response.status}`);
}

async function claimEvent(eventId: string) {
  const { data, error } = await supabase.rpc('claim_line_webhook_event', { p_event_id: eventId });
  if (error) throw error;
  return Boolean(data);
}

async function completeEvent(eventId: string, status: 'completed' | 'failed', errorMessage: string | null = null) {
  await supabase.from('line_webhook_events').update({ status, completed_at: new Date().toISOString(), last_error: errorMessage }).eq('event_id', eventId);
}

async function getProfile(lineUserId: string) {
  const { data, error } = await supabase.from('profiles').select('id').eq('line_user_id', lineUserId).maybeSingle();
  if (error) throw error;
  return data;
}

async function getMonthData(userId: string) {
  const range = bangkokMonthRange();
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
  const summary = calculateBotMonthSummary({ settings: settings.data, shiftTypes: types.data, shifts: shifts.data, specialOtItems: specialOt.data, dayOffs: dayOffs.data, financialItems: financialItems.data });
  const [year, month] = range.monthKey.split('-').map(Number);
  const monthLabel = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', month: 'long', year: 'numeric' }).format(new Date(Date.UTC(year, month - 1, 15)));
  return { range, monthLabel, summary, shiftTypes: types.data, dayOffs: dayOffs.data };
}

async function getNextShift(userId: string) {
  const now = new Date();
  const dateParts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const dateValue = (type: string) => dateParts.find((part) => part.type === type)?.value;
  const today = `${dateValue('year')}-${dateValue('month')}-${dateValue('day')}`;
  const { data, error } = await supabase.from('shifts')
    .select('work_date, start_time, end_time, shift_types!inner(name)')
    .eq('user_id', userId).gte('work_date', today).order('work_date').order('start_time').limit(31);
  if (error) throw error;
  const shift = data.find((item) => new Date(`${item.work_date}T${String(item.start_time).slice(0, 5)}:00+07:00`) >= now) || null;
  return shift ? { ...shift, shift_name: shift.shift_types.name } : null;
}

async function handlePostback(event: any, profile: { id: string }) {
  const action = parsePostbackAction(event.postback?.data);
  if (!action) return [{ type: 'text', text: 'ไม่พบคำสั่งนี้ กรุณาลองจากเมนูอีกครั้ง' }];
  if (!canShowActionInSource(action, event.source?.type)) {
    return [{ type: 'text', text: 'ข้อมูลรายได้เป็นข้อมูลส่วนตัว กรุณาเปิดแชตส่วนตัวกับ NurseShift' }];
  }
  if (action === 'help') return [createFlexMessage(action, {}, liffUrl)];
  if (action === 'next_shift') return [createFlexMessage(action, { shift: await getNextShift(profile.id) }, liffUrl)];
  const monthData = await getMonthData(profile.id);
  return [createFlexMessage(action, monthData, liffUrl)];
}

async function processEvent(event: any) {
  const eventId = String(event.webhookEventId || '');
  if (!eventId || !event.replyToken || !(await claimEvent(eventId))) return;
  try {
    const lineUserId = event.source?.userId;
    if (!lineUserId) {
      await completeEvent(eventId, 'completed');
      return;
    }
    if (event.type === 'message' && event.message?.type === 'text' && event.message.text.trim() === 'เมนูเพิ่มเติม') {
      const page2Id = Deno.env.get('LINE_RICH_MENU_PAGE_2_ID');
      if (!page2Id) throw new Error('LINE_RICH_MENU_PAGE_2_ID_MISSING');
      await linkRichMenu(lineUserId, page2Id);
      await reply(event.replyToken, [{ type: 'text', text: 'เปิดเมนูข้อมูลด่วนแล้ว แตะเมนูด้านล่างเพื่อใช้งานได้เลย' }]);
      await completeEvent(eventId, 'completed');
      return;
    }
    if (event.type !== 'postback') {
      await completeEvent(eventId, 'completed');
      return;
    }
    const profile = await getProfile(lineUserId);
    const messages = profile
      ? await handlePostback(event, profile)
      : [{ type: 'text', text: 'ยังไม่พบบัญชี NurseShift กรุณาเปิดแอปและตั้งค่าให้เรียบร้อยก่อน', quickReply: { items: [{ type: 'action', action: { type: 'uri', label: 'เปิด NurseShift', uri: liffUrl } }] } }];
    await reply(event.replyToken, messages);
    await completeEvent(eventId, 'completed');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
    await completeEvent(eventId, 'failed', message.slice(0, 200));
    console.error(JSON.stringify({ eventId, error: message }));
    throw error;
  }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  if (!channelSecret || !channelAccessToken) return json({ error: 'SERVER_CONFIGURATION_ERROR' }, 500);
  if (Number(request.headers.get('content-length') || 0) > 1_000_000) return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
  const rawBody = await request.text();
  if (rawBody.length > 1_000_000) return json({ error: 'PAYLOAD_TOO_LARGE' }, 413);
  const signature = request.headers.get('x-line-signature') || '';
  if (!(await verifyLineSignature(rawBody, signature, channelSecret))) return json({ error: 'INVALID_SIGNATURE' }, 401);
  let body;
  try { body = JSON.parse(rawBody); } catch { return json({ error: 'INVALID_JSON' }, 400); }
  try {
    await Promise.all((body.events || []).map(processEvent));
    return json({ ok: true });
  } catch {
    return json({ error: 'EVENT_PROCESSING_FAILED' }, 500);
  }
});
