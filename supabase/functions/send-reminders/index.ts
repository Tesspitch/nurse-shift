import { createClient } from 'npm:@supabase/supabase-js@2.112.3';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
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

function leadText(offsetMinutes: number) {
  if (offsetMinutes % 1440 === 0) return `ก่อน ${offsetMinutes / 1440} วัน`;
  if (offsetMinutes % 60 === 0) return `ก่อน ${offsetMinutes / 60} ชั่วโมง`;
  return `ก่อน ${offsetMinutes} นาที`;
}

async function pushLineMessage(to: string, text: string, retryKey: string) {
  const channelAccessToken = Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN');
  if (!channelAccessToken) throw new Error('LINE_CHANNEL_ACCESS_TOKEN_NOT_CONFIGURED');
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { Authorization: `Bearer ${channelAccessToken}`, 'Content-Type': 'application/json', 'X-Line-Retry-Key': retryKey },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] })
  });
  if (!response.ok) throw new Error(`LINE_PUSH_FAILED_${response.status}`);
}

function retryAt(attempts: number) {
  if (attempts >= 3) return null;
  const delayMinutes = attempts === 1 ? 5 : 10;
  return new Date(Date.now() + delayMinutes * 60_000).toISOString();
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return jsonResponse({ error: 'METHOD_NOT_ALLOWED' }, 405);
  const cronSecret = Deno.env.get('REMINDER_CRON_SECRET');
  if (!cronSecret || request.headers.get('x-cron-secret') !== cronSecret) return jsonResponse({ error: 'UNAUTHORIZED' }, 401);

  const now = new Date();
  const windowStart = new Date(now.getTime() - 30 * 60_000).toISOString();
  const windowEnd = new Date(now.getTime() + 4 * 60_000).toISOString();
  const { data: candidates, error } = await supabase
    .from('reminder_candidates')
    .select('*')
    .gte('notify_at', windowStart)
    .lt('notify_at', windowEnd);
  if (error) {
    console.error(JSON.stringify({ event: 'REMINDER_QUERY_FAILED', code: error.code }));
    return jsonResponse({ error: 'REMINDER_QUERY_FAILED' }, 500);
  }

  let claimed = 0;
  let sent = 0;
  let failed = 0;
  for (const candidate of candidates ?? []) {
    const { data: didClaim, error: claimError } = await supabase.rpc('claim_notification_delivery', {
      p_user_id: candidate.user_id,
      p_shift_id: candidate.shift_id,
      p_reminder_id: candidate.reminder_id
    });
    if (claimError) {
      failed += 1;
      console.error(JSON.stringify({ event: 'REMINDER_CLAIM_FAILED', shiftId: candidate.shift_id, code: claimError.code }));
      continue;
    }
    if (!didClaim) continue;
    claimed += 1;

    const { data: delivery } = await supabase
      .from('notification_logs')
      .select('id, attempts')
      .eq('shift_id', candidate.shift_id)
      .eq('reminder_id', candidate.reminder_id)
      .single();
    const attempts = Number(delivery?.attempts || 1);
    const retryKey = String(delivery?.id || crypto.randomUUID());
    const text = `แจ้งเตือนเวร (${leadText(candidate.offset_minutes)})\n${candidate.shift_name}\n${thaiDate(candidate.work_date)} เวลา ${String(candidate.start_time).slice(0, 5)} น.`;

    try {
      await pushLineMessage(candidate.line_user_id, text, retryKey);
      const { error: updateError } = await supabase
        .from('notification_logs')
        .update({ status: 'sent', sent_at: new Date().toISOString(), next_attempt_at: null, last_error: null })
        .eq('shift_id', candidate.shift_id)
        .eq('reminder_id', candidate.reminder_id)
        .eq('status', 'pending');
      if (updateError) throw new Error('DELIVERY_LOG_UPDATE_FAILED');
      sent += 1;
    } catch (pushError) {
      failed += 1;
      const errorCode = pushError instanceof Error ? pushError.message.slice(0, 80) : 'LINE_PUSH_FAILED';
      await supabase
        .from('notification_logs')
        .update({ status: 'failed', next_attempt_at: retryAt(attempts), last_error: errorCode })
        .eq('shift_id', candidate.shift_id)
        .eq('reminder_id', candidate.reminder_id)
        .eq('status', 'pending');
      console.error(JSON.stringify({ event: 'REMINDER_SEND_FAILED', shiftId: candidate.shift_id, attempt: attempts, error: errorCode }));
    }
  }

  const result = { checked: candidates?.length ?? 0, claimed, sent, failed };
  return jsonResponse(result, failed ? 207 : 200);
});
