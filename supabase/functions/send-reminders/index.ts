import { createClient } from 'npm:@supabase/supabase-js@2.112.3';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-cron-secret, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }
  });
}

const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  secretKeys.default ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } }
);

function thaiDate(value: string) {
  const date = new Date(`${value}T00:00:00+07:00`);
  return new Intl.DateTimeFormat('th-TH-u-ca-buddhist', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' }).format(date);
}

async function pushLineMessage(to: string, text: string) {
  const channelAccessToken = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN');
  if (!channelAccessToken) throw new Error('LINE_CHANNEL_ACCESS_TOKEN is not configured');
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { Authorization: `Bearer ${channelAccessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] })
  });
  if (!response.ok) throw new Error(`LINE_PUSH_FAILED_${response.status}`);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405);

  const cronSecret = Deno.env.get('REMINDER_CRON_SECRET');
  if (!cronSecret || request.headers.get('x-cron-secret') !== cronSecret) return jsonResponse({ error: 'UNAUTHORIZED' }, 401);

  const now = new Date();
  const windowStart = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
  const windowEnd = new Date(now.getTime() + 4 * 60 * 1000).toISOString();
  const { data: candidates, error } = await supabase
    .from('reminder_candidates')
    .select('*')
    .gte('notify_at', windowStart)
    .lt('notify_at', windowEnd);
  if (error) return jsonResponse({ error: error.message }, 500);

  let sent = 0;
  for (const candidate of candidates ?? []) {
    const { data: existing } = await supabase
      .from('notification_logs')
      .select('id')
      .eq('shift_id', candidate.shift_id)
      .eq('reminder_id', candidate.reminder_id)
      .maybeSingle();
    if (existing) continue;

    const lead = candidate.offset_minutes >= 1440
      ? `ก่อน ${candidate.offset_minutes / 1440} วัน`
      : `ก่อน ${candidate.offset_minutes} นาที`;
    const text = `แจ้งเตือนเวร (${lead})\n${candidate.shift_name}\n${thaiDate(candidate.work_date)} เวลา ${String(candidate.start_time).slice(0, 5)} น.`;
    try {
      await pushLineMessage(candidate.line_user_id, text);
      const { error: logError } = await supabase.from('notification_logs').insert({
        user_id: candidate.user_id,
        shift_id: candidate.shift_id,
        reminder_id: candidate.reminder_id
      });
      if (!logError) sent += 1;
    } catch (pushError) {
      console.error(pushError instanceof Error ? pushError.message : 'LINE_PUSH_FAILED');
    }
  }
  return jsonResponse({ checked: candidates?.length ?? 0, sent });
});
